import type { MarkdownTableData } from "../../../src/markdown/ir.js";

/** A Slack Block Kit table block (for use in `attachments`). */
export type SlackTableBlock = {
  type: "table";
  column_settings: { is_wrapped: boolean }[];
  rows: { type: "raw_text"; text: string }[][];
};

/**
 * Convert parsed markdown table data into a Slack Block Kit table block.
 *
 * Slack table blocks use a simple structure:
 * - `column_settings` defines per-column settings (wrapping, alignment)
 * - `rows` is a 2D array where the first row is the header
 * - Each cell is a `raw_text` element with a `text` field
 *
 * @see https://docs.slack.dev/reference/block-kit/blocks/table-block/
 */
export function markdownTableToBlockKit(table: MarkdownTableData): SlackTableBlock {
  const columnCount = Math.max(
    table.headers.length,
    ...table.rows.map((row) => row.length),
    0,
  );

  if (columnCount === 0) {
    return { type: "table", column_settings: [], rows: [] };
  }

  const column_settings = Array.from({ length: columnCount }, () => ({
    is_wrapped: true,
  }));

  const makeRow = (cells: string[]) =>
    Array.from({ length: columnCount }, (_, i) => ({
      type: "raw_text" as const,
      text: cells[i] ?? "",
    }));

  const rows = [makeRow(table.headers), ...table.rows.map(makeRow)];

  return { type: "table", column_settings, rows };
}

/**
 * Convert multiple parsed tables into Block Kit table blocks,
 * suitable for use in the `attachments` parameter of `chat.postMessage`.
 */
export function markdownTablesToBlockKitAttachment(
  tables: MarkdownTableData[],
): { blocks: SlackTableBlock[] }[] {
  if (!tables.length) {
    return [];
  }
  // Each attachment can contain multiple blocks.
  // We put all tables in a single attachment.
  return [
    {
      blocks: tables.map(markdownTableToBlockKit),
    },
  ];
}
