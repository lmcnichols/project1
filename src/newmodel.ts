import { DSVModel } from 'tde-csvviewer';
import { MutableDataModel, DataModel, SelectionModel } from 'tde-datagrid';
import { Fields, MapField, ListField } from 'tde-datastore';
import { Litestore } from './litestore';
import { toArray, range } from '@lumino/algorithm';
import { serializer } from './serialize';

export class EditorModel extends MutableDataModel {
  private _clipboard: Array<Array<string>>;
  private _litestore: Litestore;
  private _model: DSVModel;
  private _rowsAdded: number;
  private _columnsAdded: number;
  private _currentRows: number;
  // private _onChangeSignal: Signal<this, string> = new Signal<this, string>(
  //   this
  // );

  constructor(options: DSVModel.IOptions) {
    super();
    // Define our model.
    this._model = new DSVModel(options);

    // Connect to the model's signals to recieve updates.
    this._model.changed.connect(this._receiveModelSignal, this);

    this._currentRows = this.totalRows();

    // Arrays which map the requested row/column to the
    // row/column where the data actually lives, initially
    // set to [0, 1, ..., total rows - 1] & [0, 1, ..., total columns - 1]
    const rowValues = toArray(range(0, this.totalRows()));
    const columnValues = toArray(range(0, this.totalColumns()));
    const rowSplice = { index: 0, remove: 0, values: rowValues };
    const columnSplice = { index: 0, remove: 0, values: columnValues };

    // Set up variables to record the values of the rows/columnsdd we added.
    this._rowsAdded = 0;
    this._columnsAdded = 0;

    // initialize the litestore
    this._litestore = new Litestore({ id: 0, schemas: [DATAMODEL_SCHEMA] });

    // update the lightstore
    this._updateLitestore({ rowUpdate: rowSplice, columnUpdate: columnSplice });
  }

  get model(): DSVModel {
    return this._model;
  }

  get litestore(): Litestore {
    return this._litestore;
  }

  /**
   * The grid's current number of rows by region.
   *
   */
  rowCount(region: DataModel.RowRegion): number {
    if (region === 'body') {
      return this._model.rowCount('body') + this._rowsAdded;
    }
    return 1;
  }

  /**
   * The grid's current number of columns by region.
   *
   * Note: the UI components use this method to get the column count
   * so it should reflect the grid's columns.
   */
  columnCount(region: DataModel.ColumnRegion): number {
    if (region === 'body') {
      return this._model.columnCount('body') + this._columnsAdded;
    }
    return 1;
  }

  /**
   * The grid's current number of rows. TOTAL, NOT BY REGION.
   */
  totalRows(): number {
    return this._model.rowCount('body') + this._rowsAdded + 1;
  }

  /**
   * The grid's current number of columns. TOTAL, NOT BY REGION.
   *
   * Notes: This is equivalent to columnCount('body')
   */

  totalColumns(): number {
    return this._model.columnCount('body') + this._columnsAdded;
  }

  data(region: DataModel.CellRegion, row: number, column: number): any {
    // The model is defered to if the region is a row header.
    if (region === 'row-header') {
      return this._model.data(region, row, column);
    }

    // The row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    row = this._absoluteIndex(row, region);

    // unpack the maps from the LiteStore.
    const { rowMap, columnMap, valueMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    // Map from the cell on the grid to the cell in the model.
    row = rowMap[row];
    column = columnMap[column];

    // check if a new value has been stored at this cell.
    if (valueMap[`${row},${column}`] !== undefined) {
      return valueMap[`${row},${column}`];
    }

    if (!Number.isInteger(row) || !Number.isInteger(column)) {
      // we are on a new column or row which has no maped
      // value, so we know that the value must be empty
      return '';
    }

    // the model's data method assumes the grid's row IDs.
    row = this._regionIndex(row, region);

    // fetch the value from the data
    return this._model.data(region, row, column);
  }

  setData(
    region: DataModel.CellRegion,
    row: number,
    column: number,
    values: any,
    rowSpan = 1,
    columnSpan = 1,
    updating = true
  ): boolean {
    // The row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    row = this._absoluteIndex(row, region);

    // unpack Litestore values.
    const { rowMap, columnMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    // Set up an udate object for the litestore.
    const valueUpdate: { [key: string]: string } = {};

    // If we got a singleton, coerce it into an array.
    values = Array.isArray(values) ? values : [[values]];

    // set up a loop to go through each value.
    let currentRow: number;
    let currentColumn: number;
    let key: string;
    for (let i = 0; i < rowSpan; i++) {
      currentRow = rowMap[row + i];
      for (let j = 0; j < columnSpan; j++) {
        currentColumn = columnMap[column + j];
        key = `${currentRow},${currentColumn}`;
        valueUpdate[key] = values[i][j];
      }
    }

    // Revert to the row index by region, which is what the grid expects.
    row = this._regionIndex(row, region);

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'cells-changed',
      region,
      row,
      column,
      rowSpan,
      columnSpan
    };

    if (updating) {
      // Update the litestore.
      this._updateLitestore({ valueUpdate, change });

      // Emit the change.
      this._handleEmits(change);
    }
    return true;
  }

  /**
   * @param start: the index at which to start adding rows.
   * @param span: the number of rows to add. Default is 1.
   *
   * Notes: this method (and all others that follow it)
   */
  addRows(region: DataModel.CellRegion, start: number, span = 1): void {
    // The row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    start = this._absoluteIndex(start, region);

    const { rowMap, inverseRM } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    // store the next span's worth of values.
    const values = [];
    let i = 0;
    while (i < span) {
      values.push(rowMap.length + 0.5);
      i++;
      this._rowsAdded++;
    }

    // Create the splice data for the litestore.
    const rowUpdate = { index: start, remove: 0, values };
    // Append the added values to the end of the inverseCM
    const appendSplice = { index: inverseRM.length, remove: 0, values };
    const end = inverseRM.length + values.length - 1;
    const splice = this.rowMapSplice(rowMap, start, end, span);
    const inverseCUpdate = [appendSplice, ...splice];

    // Revert to the row index by region, which is what the grid expects.
    start = this._regionIndex(start, region);

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'rows-inserted',
      region: 'body',
      index: start,
      span: span
    };

    // Have the Litestore apply the splice.
    this._updateLitestore({ rowUpdate, inverseCUpdate, change });

    // Emit the change.
    this._handleEmits(change);
  }

  /**
   *
   * @param start the index at which to start adding columns.
   * @param span the number of columns to add. Default is 1.
   */
  addColumns(region: DataModel.CellRegion, start: number, span = 1): void {
    // store the next span's worth of values

    const { columnMap, inverseCM } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });
    const values = [];
    const columnHeaders: { [key: string]: string } = {};
    let i = 0;
    while (i < span) {
      values.push(columnMap.length + 0.5);
      columnHeaders[`0,${columnMap.length}`] = `Column ${start + i + 1}`;
      i++;
      this._columnsAdded++;
    }

    // Create the splice data for the litestore.
    const columnUpdate = { index: start, remove: 0, values };
    // Append the added values to the end of the inverseCM
    const appendSplice = { index: inverseCM.length, remove: 0, values };
    const end = inverseCM.length + values.length - 1;
    const splice = this.columnMapSplice(columnMap, start, end, span);
    const inverseCUpdate = [appendSplice, ...splice];

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'columns-inserted',
      region: 'body',
      index: start,
      span: span
    };

    // Update the litestore.
    this._updateLitestore({
      columnUpdate,
      inverseCUpdate,
      valueUpdate: columnHeaders,
      change
    });

    // Emit the change.
    this._handleEmits(change);
  }

  /**
   *
   * @param start the index to start removing the rows
   * @param span the number of rows to remove
   */
  removeRows(region: DataModel.CellRegion, start: number, span = 1): void {
    // The row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    start = this._absoluteIndex(start, region);

    // We treat removing as moving the values to the end. This allows
    // us to preserve symmetry between the inverse map and the map.

    const { rowMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    const rowUpdate = this.rowMapSplice(rowMap, start, rowMap.length - 1, span);
    const [iStart, iEnd] = this.inverseSpliceParams(
      start,
      rowMap.length - 1,
      span
    );
    const inverseRUpdate = this.rowMapSplice(rowMap, iStart, iEnd, span);

    // update the row count.
    this._rowsAdded -= span;

    // Revert to the row index by region, which is what the grid expects.
    start = this._regionIndex(start, region);

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'rows-removed',
      region: 'body',
      index: start,
      span: span
    };

    // Update the litestore.
    this._updateLitestore({ rowUpdate, inverseRUpdate, change });

    // Emit the change.
    this._handleEmits(change);
  }

  /**
   *
   * @param start the index to start removing the columns
   * @param span the number of columns to remove
   */

  removeColumns(region: DataModel.CellRegion, start: number, span = 1): void {
    // We treat removing as moving the values to the end. This allows
    // us to preserve symmetry between the inverse map and the map.

    const { columnMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    const columnUpdate = this.columnMapSplice(
      columnMap,
      start,
      columnMap.length - 1,
      span
    );
    const [iStart, iEnd] = this.inverseSpliceParams(
      start,
      columnMap.length - 1,
      span
    );
    const inverseCUpdate = this.columnMapSplice(columnMap, iStart, iEnd, span);

    // Updating the column count will allow us to keep in sync with the grid even as
    // we have extra columns at the end of our columnMap
    this._columnsAdded -= span;

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'columns-removed',
      region: 'body',
      index: start,
      span: span
    };

    // Update the litestore.
    this._updateLitestore({ columnUpdate, inverseCUpdate, change });

    // Emit the change.
    this._handleEmits(change);
  }

  /**
   *
   * @param start the index of the first column to move
   * @param end the index to insert the first column
   * @param span the number of columns moving
   */

  moveRows(
    region: DataModel.CellRegion,
    start: number,
    end: number,
    span: number
  ): void {
    // Start and end come to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    start = this._absoluteIndex(start, region);
    end = this._absoluteIndex(end, region);

    // bail early if we are moving no distance
    if (start === end) {
      return;
    }

    const { rowMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    const rowUpdate = this.rowMapSplice(rowMap, start, end, span);
    const [iStart, iEnd] = this.inverseSpliceParams(start, end, span);
    const inverseRUpdate = this.rowMapSplice(rowMap, iStart, iEnd, span);

    // Revert to the row index by region, which is what the grid expects.
    start = this._regionIndex(start, region);
    end = this._regionIndex(end, region);

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'rows-moved',
      region: 'body',
      index: start,
      span: span,
      destination: end
    };

    // Update the litestore.
    this._updateLitestore({ rowUpdate, inverseRUpdate, change });

    // Emit the change.
    this._handleEmits(change);
  }

  rowMapSplice(
    rowMap: ListField.Value<number>,
    start: number,
    end: number,
    span: number
  ): ListField.Splice<number>[] {
    // Get the values of the moving rows.
    const valuesMoving = rowMap.slice(start, start + span);

    // Figure out which way we are moving.
    const directionMoving = start < end ? 'down' : 'up';

    // if moving down, we just grabbed rows above the desitnation,
    // which means we removed values BEFORE end which we must account for
    // when inserting again.
    let destination: number;
    switch (directionMoving) {
      case 'down': {
        // Add 1 because we want to insert AFTER end - span.
        destination = end - span + 1;
        break;
      }
      case 'up': {
        destination = end;
      }
    }

    // Create the splice object for the Litestore.
    const noValue: number[] = [];
    const rowSplice = [
      { index: start, remove: span, values: noValue },
      { index: destination, remove: 0, values: valuesMoving }
    ];
    return rowSplice;
  }

  /**
   *
   * @param start the index of the first column to move
   * @param end the index to insert the first column
   * @param span the number of columns moving
   */
  moveColumns(
    region: DataModel.CellRegion,
    start: number,
    end: number,
    span: number
  ): void {
    // bail early if we are moving no distance
    if (start === end) {
      return;
    }

    const { columnMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    const columnUpdate = this.columnMapSplice(columnMap, start, end, span);
    const [iStart, iEnd] = this.inverseSpliceParams(start, end, span);
    const inverseCUpdate = this.columnMapSplice(columnMap, iStart, iEnd, span);

    // Define the change.
    const change: DataModel.ChangedArgs = {
      type: 'columns-moved',
      region: 'body',
      index: start,
      span: span,
      destination: end
    };

    // Update the litestore.
    this._updateLitestore({ columnUpdate, inverseCUpdate, change });

    // Emit the change.
    this._handleEmits(change);
  }

  columnMapSplice(
    columnMap: ListField.Value<number>,
    start: number,
    end: number,
    span: number
  ): ListField.Splice<number>[] {
    // Unpack the columnMap from the litestore.

    // Get the values of the moving columns.
    const valuesMoving = columnMap.slice(start, start + span);

    // need to figure out which way we are moving. This is based
    // on the REAL columns start and end
    const directionMoving = start < end ? 'right' : 'left';

    // if moving right, we just grabbed columns left of the desitnation,
    // which means we removed values BEFORE end which we must account for
    // when inserting again.
    let destination: number;
    switch (directionMoving) {
      case 'right': {
        // Add 1 because we want to insert AFTER end - span.
        destination = end - span + 1;
        break;
      }
      case 'left': {
        destination = end;
      }
    }

    // Create the splice object for the Litestore.
    const noValue: number[] = [];
    const columnSplice = [
      { index: start, remove: span, values: noValue },
      { index: destination, remove: 0, values: valuesMoving }
    ];

    return columnSplice;
  }

  inverseSpliceParams(start: number, end: number, span: number) {
    let iStart, iEnd: number;
    if (start < end) {
      iStart = end - span + 1;
      iEnd = start;
      return [iStart, iEnd];
    }
    iStart = end;
    iEnd = start + span - 1;
    return [iStart, iEnd];
  }

  /**
   * Clears the contents of the selected region
   * Keybind: ['Backspace']
   */
  clearContents(selection: SelectionModel.Selection): void {
    // Unpack the selection.
    const { r1, r2, c1, c2 } = selection;
    // Check if the selected is a corner header.
    if (Math.abs(r1 - r2) >= 100 && Math.abs(c1 - c2) >= 100) {
      return;
    }
    let row, column, rowSpan, columnSpan: number;

    // Check if we are on a column header.
    if (Math.abs(r1 - r2) >= 100) {
      // Set up arguments for clearColumns method.
      column = Math.min(c1, c2);
      columnSpan = Math.abs(c1 - c2) + 1;
      this.clearColumns('body', column, columnSpan);
      return;
    }
    // Check if we are on a row header.
    if (Math.abs(c1 - c2) >= 100) {
      // Set up arguments for clearRows method.
      row = Math.min(r1, r2);
      rowSpan = Math.abs(r1 - r2) + 1;
      this.clearRows('body', row, rowSpan);
      return;
    }
    // Otherwise, we have a body selection. Set up args for setData
    row = Math.min(r1, r2);
    rowSpan = Math.abs(r1 - r2) + 1;
    column = Math.min(c1, c2);
    columnSpan = Math.abs(c1 - c2) + 1;
    const values = new Array(rowSpan)
      .fill(0)
      .map(elem => new Array(columnSpan).fill(''));
    this.setData('body', row, column, values, rowSpan, columnSpan);
  }

  clearRows(region: DataModel.CellRegion, start: number, span = 1): void {
    // The row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    start = this._absoluteIndex(start, region);

    const { rowMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });

    // Set up values to stand in for the blank rows.
    const values = [];
    let i = 0;
    while (i < span) {
      values.push(rowMap.length);
      i++;
    }
    // Set up the row splice object to update the litestore.
    const rowSplice = { index: start, remove: span, values };

    // Revert to the row index by region, which is what the grid expects.
    start = this._regionIndex(start, region);

    // Define the change.
    let change: DataModel.ChangedArgs = {
      type: 'cells-changed',
      region: 'body',
      row: start,
      rowSpan: span,
      column: 0,
      columnSpan: this.totalColumns()
    };

    // Have the Litestore apply the splice.
    this._updateLitestore({ rowUpdate: rowSplice, change });

    // The DataGrid is slow to process a cells-change argument with
    // a very large span, so in this instance we elect to use the "big
    // hammer".

    change = { type: 'model-reset' };

    // Emit the change.
    this._handleEmits(change);
  }

  clearColumns(region: DataModel.CellRegion, start: number, span = 1) {
    const { columnMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });
    // Set up values to stand in for the blank rows.
    const values = [];
    let i = 0;
    while (i < span) {
      values.push(columnMap.length);
      i++;
    }
    // Set up the row splice object to update the litestore.
    const columnSplice = { index: start, remove: span, values };

    // Define the change.
    let change: DataModel.ChangedArgs = {
      type: 'cells-changed',
      region: 'body',
      row: 0,
      rowSpan: this.totalRows() - 10,
      column: start,
      columnSpan: span
    };

    // Have the Litestore apply the splice.
    this._updateLitestore({ columnUpdate: columnSplice, change });

    // The DataGrid is slow to process a cells-change argument with
    // a very large span, so in this instance we elect to use the "big
    // hammer".

    change = { type: 'model-reset' };

    // Emit the change.
    this._handleEmits(change);
  }

  cut(
    region: DataModel.CellRegion,
    row: number,
    column: number,
    rowSpan: number,
    columnSpan: number
  ): void {
    // we use the value map to redefine values within the cut as ''. Need to map
    // to the static values.
    // copy the values
    this.copy(region, row, column, rowSpan, columnSpan);

    // Fill in the new blank values.
    const values = new Array(rowSpan)
      .fill('')
      .map(elem => new Array(columnSpan).fill(''));
    // set the new data.
    this.setData(region, row, column, values, rowSpan, columnSpan);
  }

  copy(
    region: DataModel.CellRegion,
    row: number,
    column: number,
    rowSpan: number,
    columnSpan: number
  ): void {
    // we use the value map to redefine values within the cut as ''. Need to map
    // to the static values.
    // clear previous values from the clipboard
    this._clipboard = new Array(rowSpan)
      .fill(0)
      .map(elem => new Array(columnSpan).fill(0));
    for (let i = 0; i < rowSpan; i++) {
      for (let j = 0; j < columnSpan; j++) {
        // make a temporary copy of the values
        this._clipboard[i][j] = this.data(region, row + i, column + j);
      }
    }
  }

  paste(
    region: DataModel.CellRegion,
    row: number,
    column: number,
    data: string | null = null
  ): void {
    // see if we have stored it in our local array
    if (this._clipboard.length === 0) {
      if (data !== null) {
        // convert the copied data to an array
        this._clipboard = data.split('\n').map(elem => elem.split('\t'));
      } else {
        // we have no data, so bail
        return;
      }
    }
    // Row comes to us as an index on a particular region. We need the
    // absolute index (ie index 0 is the first row of data).
    row = this._absoluteIndex(row, region);

    // see how much space we have
    const rowsBelow = this.totalRows() - row;
    const columnsRight = this.totalColumns() - column;

    // clamp the values we are adding at the bounds of the grid
    const rowSpan = Math.min(rowsBelow, this._clipboard.length);
    const columnSpan = Math.min(columnsRight, this._clipboard[0].length);

    // Revert to the row index by region, which is what the grid expects.
    row = this._regionIndex(row, region);

    // set the data
    this.setData(
      region,
      row,
      column,
      [...this._clipboard],
      rowSpan,
      columnSpan
    );
  }

  undo(change: DataModel.ChangedArgs): void {
    // Bail early if there is no change.
    if (!change) {
      return;
    }

    // Undo
    this._litestore.undo();

    // submit a signal to the DataGrid based on the change.
    let undoChange: DataModel.ChangedArgs;
    switch (change.type) {
      case 'cells-changed':
        // add the visual element of reselecting the cell where the change happened.

        undoChange = {
          type: 'cells-changed',
          region: 'body',
          row: change.row,
          column: change.column,
          rowSpan: change.rowSpan,
          columnSpan: change.columnSpan
        };
        break;
      case 'rows-inserted':
        undoChange = {
          type: 'rows-removed',
          region: 'body',
          index: change.index,
          span: change.span
        };
        this._rowsAdded -= undoChange.span;
        break;
      case 'columns-inserted':
        undoChange = {
          type: 'columns-removed',
          region: 'body',
          index: change.index,
          span: change.span
        };
        this._columnsAdded -= change.span;
        break;
      case 'rows-removed':
        undoChange = {
          type: 'rows-inserted',
          region: 'body',
          index: change.index,
          span: change.span
        };
        this._rowsAdded += undoChange.span;
        break;
      case 'columns-removed':
        undoChange = {
          type: 'columns-inserted',
          region: 'body',
          index: change.index,
          span: change.span
        };
        this._columnsAdded += change.span;
        break;
      case 'rows-moved':
        undoChange = {
          type: 'rows-moved',
          region: 'body',
          index: change.destination,
          destination: change.index,
          span: change.span
        };
        break;
      case 'columns-moved':
        undoChange = {
          type: 'columns-moved',
          region: 'body',
          index: change.destination,
          destination: change.index,
          span: change.span
        };
        break;
    }
    this._handleEmits(undoChange);
  }

  redo(change: DataModel.ChangedArgs): void {
    this._litestore.redo();
    switch (change.type) {
      case 'columns-inserted': {
        this._columnsAdded += change.span;
        break;
      }
      case 'columns-removed': {
        this._columnsAdded -= change.span;
        break;
      }
      case 'rows-inserted': {
        this._rowsAdded += change.span;
        break;
      }
      case 'rows-removed': {
        this._rowsAdded -= change.span;
      }
    }
    // Emit the change.
    this._handleEmits(change);
  }

  updateString(): void {
    // Get the current litestore values.
    // Unpack the columnMap from the litestore.
    console.log(this.litestore.getHistory());
    const { rowMap, columnMap } = this._litestore.getRecord({
      schema: DATAMODEL_SCHEMA,
      record: RECORD_ID
    });
    this.model.rawData = serializer(rowMap, columnMap, this._model);
  }

  /**
   * translate from the Grid's row IDs to our own standard
   */
  private _absoluteIndex(row: number, region: DataModel.CellRegion) {
    return region === 'column-header' ? 0 : row + 1;
  }

  /**
   * translate from our unique row ID to the Grid's standard
   */
  private _regionIndex(row: number, region: DataModel.CellRegion) {
    return region === 'column-header' ? 0 : row - 1;
  }

  private _updateLitestore(updates: LitestoreChangeArgs) {
    const {
      rowUpdate: rowSplice,
      columnUpdate: columnSplice,
      valueUpdate: newValue,
      change
    } = updates;
    const nullValue: number[] = [];
    const nullSplice = { index: 0, remove: 0, values: nullValue };
    this._litestore.beginTransaction();
    this._litestore.updateRecord(
      {
        schema: DATAMODEL_SCHEMA,
        record: RECORD_ID
      },
      {
        rowMap: rowSplice || nullSplice,
        columnMap: columnSplice || nullSplice,
        valueMap: newValue || null,
        change: change || null
      }
    );
    this._litestore.endTransaction();
  }

  private _handleEmits(change: DataModel.ChangedArgs): void {
    // Emits the updates to the DataModel to the DataGrid for rerender
    this.emitChanged(change);
  }

  private _receiveModelSignal(
    emitter: DSVModel,
    message: DataModel.ChangedArgs
  ): void {
    if (message.type === 'rows-inserted') {
      const start = this._currentRows;
      const span = message.span;
      this.addColumns('body', start, span);
    }
    // Emit the change up to the Grid.
    this.emitChanged(message);
  }
}

export const SCHEMA_ID = 'datamodel';
export const RECORD_ID = 'datamodel';
export const DATAMODEL_SCHEMA = {
  id: SCHEMA_ID,
  fields: {
    rowMap: Fields.List<number>(),
    inverseRM: Fields.List<number>(),
    columnMap: Fields.List<number>(),
    inverseCM: Fields.List<number>(),
    valueMap: Fields.Map<string>(),
    change: Fields.Register<DataModel.ChangedArgs>({
      value: { type: 'model-reset' }
    })
  }
};

export type LitestoreChangeArgs = {
  rowUpdate?: ListField.Update<number>;
  inverseRUpdate?: ListField.Update<number>;
  columnUpdate?: ListField.Update<number>;
  inverseCUpdate?: ListField.Update<number>;
  valueUpdate?: MapField.Update<string>;
  change?: DataModel.ChangedArgs;
};