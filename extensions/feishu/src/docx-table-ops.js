const MIN_COLUMN_WIDTH = 50;
const MAX_COLUMN_WIDTH = 400;
const DEFAULT_TABLE_WIDTH = 730;
function calculateAdaptiveColumnWidths(blocks, tableBlockId) {
  const tableBlock = blocks.find((b) => b.block_id === tableBlockId && b.block_type === 31);
  if (!tableBlock?.table?.property) {
    return [];
  }
  const { row_size, column_size, column_width: originalWidths } = tableBlock.table.property;
  const totalWidth = originalWidths && originalWidths.length > 0 ? originalWidths.reduce((a, b) => a + b, 0) : DEFAULT_TABLE_WIDTH;
  const cellIds = tableBlock.children || [];
  const blockMap = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    blockMap.set(block.block_id, block);
  }
  function getCellText(cellId) {
    const cell = blockMap.get(cellId);
    if (!cell?.children) return "";
    let text = "";
    const childIds = Array.isArray(cell.children) ? cell.children : [cell.children];
    for (const childId of childIds) {
      const child = blockMap.get(childId);
      if (child?.text?.elements) {
        for (const elem of child.text.elements) {
          if (elem.text_run?.content) {
            text += elem.text_run.content;
          }
        }
      }
    }
    return text;
  }
  function getWeightedLength(text) {
    return [...text].reduce((sum, char) => {
      return sum + (char.charCodeAt(0) > 255 ? 2 : 1);
    }, 0);
  }
  const maxLengths = new Array(column_size).fill(0);
  for (let row = 0; row < row_size; row++) {
    for (let col = 0; col < column_size; col++) {
      const cellIndex = row * column_size + col;
      const cellId = cellIds[cellIndex];
      if (cellId) {
        const content = getCellText(cellId);
        const length = getWeightedLength(content);
        maxLengths[col] = Math.max(maxLengths[col], length);
      }
    }
  }
  const totalLength = maxLengths.reduce((a, b) => a + b, 0);
  if (totalLength === 0) {
    const equalWidth = Math.max(
      MIN_COLUMN_WIDTH,
      Math.min(MAX_COLUMN_WIDTH, Math.floor(totalWidth / column_size))
    );
    return new Array(column_size).fill(equalWidth);
  }
  let widths = maxLengths.map((len) => {
    const proportion = len / totalLength;
    return Math.round(proportion * totalWidth);
  });
  widths = widths.map((w) => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, w)));
  let remaining = totalWidth - widths.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    const growable = widths.map((w, i) => w < MAX_COLUMN_WIDTH ? i : -1).filter((i) => i >= 0);
    if (growable.length === 0) break;
    const perColumn = Math.floor(remaining / growable.length);
    if (perColumn === 0) break;
    for (const i of growable) {
      const add = Math.min(perColumn, MAX_COLUMN_WIDTH - widths[i]);
      widths[i] += add;
      remaining -= add;
    }
  }
  return widths;
}
function cleanBlocksForDescendant(blocks) {
  const tableWidths = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (block.block_type === 31) {
      const widths = calculateAdaptiveColumnWidths(blocks, block.block_id);
      tableWidths.set(block.block_id, widths);
    }
  }
  return blocks.map((block) => {
    const { parent_id: _parentId, ...cleanBlock } = block;
    if (cleanBlock.block_type === 32 && typeof cleanBlock.children === "string") {
      cleanBlock.children = [cleanBlock.children];
    }
    if (cleanBlock.block_type === 31 && cleanBlock.table) {
      const { cells: _cells, ...tableWithoutCells } = cleanBlock.table;
      const { row_size, column_size } = tableWithoutCells.property || {};
      const adaptiveWidths = tableWidths.get(block.block_id);
      cleanBlock.table = {
        property: {
          row_size,
          column_size,
          ...adaptiveWidths?.length && { column_width: adaptiveWidths }
        }
      };
    }
    return cleanBlock;
  });
}
async function insertTableRow(client, docToken, blockId, rowIndex = -1) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { insert_table_row: { row_index: rowIndex } }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}
async function insertTableColumn(client, docToken, blockId, columnIndex = -1) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { insert_table_column: { column_index: columnIndex } }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}
async function deleteTableRows(client, docToken, blockId, rowStart, rowCount = 1) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { delete_table_rows: { row_start_index: rowStart, row_end_index: rowStart + rowCount } }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, rows_deleted: rowCount, block: res.data?.block };
}
async function deleteTableColumns(client, docToken, blockId, columnStart, columnCount = 1) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      delete_table_columns: {
        column_start_index: columnStart,
        column_end_index: columnStart + columnCount
      }
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, columns_deleted: columnCount, block: res.data?.block };
}
async function mergeTableCells(client, docToken, blockId, rowStart, rowEnd, columnStart, columnEnd) {
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      merge_table_cells: {
        row_start_index: rowStart,
        row_end_index: rowEnd,
        column_start_index: columnStart,
        column_end_index: columnEnd
      }
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block: res.data?.block };
}
export {
  calculateAdaptiveColumnWidths,
  cleanBlocksForDescendant,
  deleteTableColumns,
  deleteTableRows,
  insertTableColumn,
  insertTableRow,
  mergeTableCells
};
