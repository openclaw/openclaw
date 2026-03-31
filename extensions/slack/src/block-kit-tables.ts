import type { MarkdownTableData } from "openclaw/plugin-sdk/text-runtime";

const SLACK_MAX_TABLE_COLUMNS = 20;
const SLACK_MAX_TABLE_ROWS = 100;
const SLACK_MAX_FALLBACK_CELL_WIDTH = 80;
const SLACK_MAX_FALLBACK_TEXT_LENGTH = 4000;

type SlackTableCell = {
  type: "raw_text";
  text: string;
};

export type SlackTableBlock = {
  type: "table";
  column_settings: {
    is_wrapped: boolean;
  }[];
  rows: SlackTableCell[][];
};

function hasVisibleHeaders(headers: string[]): boolean {
  for (const header of headers) {
    if (header.length > 0) {
      return true;
    }
  }
  return false;
}

function getCappedRowCount(rows: string[][]): number {
  return Math.min(rows.length, SLACK_MAX_TABLE_ROWS);
}

function getMaxColumnCount(headers: string[], rows: string[][]): number {
  let maxColumns = headers.length;
  const rowCount = getCappedRowCount(rows);
  for (let index = 0; index < rowCount; index += 1) {
    const rowLength = rows[index]?.length ?? 0;
    if (rowLength > maxColumns) {
      maxColumns = rowLength;
    }
  }
  return Math.min(maxColumns, SLACK_MAX_TABLE_COLUMNS);
}

function truncateFallbackCell(value: string): string {
  if (value.length <= SLACK_MAX_FALLBACK_CELL_WIDTH) {
    return value;
  }
  return `${value.slice(0, SLACK_MAX_FALLBACK_CELL_WIDTH - 3)}...`;
}

export function markdownTableToSlackTableBlock(table: MarkdownTableData): SlackTableBlock {
  const columnCount = getMaxColumnCount(table.headers, table.rows);

  if (columnCount === 0) {
    return { type: "table", column_settings: [], rows: [] };
  }

  const makeRow = (cells: string[]): SlackTableCell[] =>
    Array.from({ length: columnCount }, (_, index) => ({
      type: "raw_text",
      text: cells[index] ?? "",
    }));

  const rows = [
    ...(hasVisibleHeaders(table.headers) ? [makeRow(table.headers)] : []),
    ...table.rows.slice(0, SLACK_MAX_TABLE_ROWS).map(makeRow),
  ].slice(0, SLACK_MAX_TABLE_ROWS);

  return {
    type: "table",
    column_settings: Array.from({ length: columnCount }, () => ({ is_wrapped: true })),
    rows,
  };
}

export function buildSlackTableAttachment(table: MarkdownTableData): { blocks: SlackTableBlock[] } {
  return {
    blocks: [markdownTableToSlackTableBlock(table)],
  };
}

export function renderSlackTableFallbackText(table: MarkdownTableData): string {
  const hasHeaders = hasVisibleHeaders(table.headers);
  const cappedRows = table.rows.slice(0, SLACK_MAX_TABLE_ROWS);
  const rows = [
    ...(hasHeaders ? [table.headers] : []),
    ...cappedRows,
  ].filter((row) => row.length > 0);
  if (rows.length === 0) {
    return "Table";
  }

  const columnCount = getMaxColumnCount(table.headers, cappedRows);
  const widths = Array.from({ length: columnCount }, () => 1);
  const safeRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, columnIndex) =>
      truncateFallbackCell(row[columnIndex] ?? ""),
    ),
  );

  for (const row of safeRows) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const width = row[columnIndex]?.length ?? 0;
      if (width > (widths[columnIndex] ?? 1)) {
        widths[columnIndex] = width;
      }
    }
  }

  const lines: string[] = [];
  let totalLength = 0;
  for (let rowIndex = 0; rowIndex < safeRows.length; rowIndex += 1) {
    const cells = Array.from({ length: columnCount }, (_, columnIndex) =>
      (safeRows[rowIndex]?.[columnIndex] ?? "").padEnd(widths[columnIndex] ?? 1),
    );
    const line = `| ${cells.join(" | ")} |`;
    if (totalLength + line.length > SLACK_MAX_FALLBACK_TEXT_LENGTH) {
      break;
    }
    lines.push(line);
    totalLength += line.length + 1;
    if (rowIndex === 0 && hasHeaders) {
      const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
      if (totalLength + separator.length > SLACK_MAX_FALLBACK_TEXT_LENGTH) {
        break;
      }
      lines.push(separator);
      totalLength += separator.length + 1;
    }
  }

  return lines.length > 0 ? lines.join("\n") : "Table";
}
