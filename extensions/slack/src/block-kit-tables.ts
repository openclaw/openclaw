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

  const truncatedCount = Math.max(0, table.rows.length - SLACK_MAX_TABLE_ROWS);

  const rows = [
    ...(hasVisibleHeaders(table.headers) ? [makeRow(table.headers)] : []),
    ...table.rows.slice(0, SLACK_MAX_TABLE_ROWS).map(makeRow),
  ].slice(0, SLACK_MAX_TABLE_ROWS);

  if (truncatedCount > 0) {
    const indicatorCells = Array.from({ length: columnCount }, () => "");
    indicatorCells[0] = `+${truncatedCount} more rows`;
    rows.push(makeRow(indicatorCells));
  }

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
  const rows = [...(hasHeaders ? [table.headers] : []), ...cappedRows].filter(
    (row) => row.length > 0,
  );
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

  if (lines.length > 0 && table.rows.length > SLACK_MAX_TABLE_ROWS) {
    const truncatedCount = table.rows.length - SLACK_MAX_TABLE_ROWS;
    lines.push(`+${truncatedCount} more rows`);
  }

  return lines.length > 0 ? lines.join("\n") : "Table";
}

/**
 * Build Slack message attachments for one or more tables.
 * Slack allows at most one table block per message, so when multiple tables
 * are present this returns `undefined` (caller should fall back to code blocks).
 */
export function buildSlackTableAttachments(
  tables: MarkdownTableData[],
): Record<string, unknown>[] | undefined {
  if (tables.length !== 1 || !tables[0]) {
    return undefined;
  }
  return [buildSlackTableAttachment(tables[0])];
}

/**
 * Render all tables as aligned pipe-text (code-block friendly).
 * Used when Block Kit attachments aren't viable (multiple tables, fallback).
 */
export function renderSlackTablesFallbackText(tables: MarkdownTableData[]): string {
  if (tables.length === 0) {
    return "Table";
  }
  return tables.map((t) => renderSlackTableFallbackText(t)).join("\n\n");
}
