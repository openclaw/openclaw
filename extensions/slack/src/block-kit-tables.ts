import type { MarkdownTableData } from "openclaw/plugin-sdk/text-runtime";

const SLACK_MAX_TABLE_COLUMNS = 20;
const SLACK_MAX_TABLE_ROWS = 100;

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

export function markdownTableToSlackTableBlock(table: MarkdownTableData): SlackTableBlock {
  const columnCount = Math.min(
    Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0),
    SLACK_MAX_TABLE_COLUMNS,
  );

  if (columnCount === 0) {
    return { type: "table", column_settings: [], rows: [] };
  }

  const makeRow = (cells: string[]): SlackTableCell[] =>
    Array.from({ length: columnCount }, (_, index) => ({
      type: "raw_text",
      text: cells[index] ?? "",
    }));

  const rows = [
    ...(table.headers.some((header) => header.length > 0) ? [makeRow(table.headers)] : []),
    ...table.rows.map(makeRow),
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
  const rows = [
    ...(table.headers.some((header) => header.length > 0) ? [table.headers] : []),
    ...table.rows,
  ]
    .filter((row) => row.length > 0)
    .slice(0, SLACK_MAX_TABLE_ROWS);
  if (rows.length === 0) {
    return "Table";
  }

  const columnCount = Math.min(Math.max(...rows.map((row) => row.length)), SLACK_MAX_TABLE_COLUMNS);
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => (row[columnIndex] ?? "").length), 1),
  );

  const lines: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = Array.from({ length: columnCount }, (_, columnIndex) =>
      (rows[rowIndex]?.[columnIndex] ?? "").padEnd(widths[columnIndex] ?? 1),
    );
    lines.push(`| ${cells.join(" | ")} |`);
    if (rowIndex === 0 && table.headers.length > 0) {
      lines.push(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
    }
  }

  return lines.join("\n");
}
