import type { MarkdownTableData } from "openclaw/plugin-sdk/text-runtime";

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
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);

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

  // Only include a header row if there are actual headers with content.
  const hasHeaders = table.headers.some((h) => h.length > 0);
  const rows = [...(hasHeaders ? [makeRow(table.headers)] : []), ...table.rows.map(makeRow)];

  return { type: "table", column_settings, rows };
}

/**
 * Slack allows **at most one table block per message**.
 *
 * Convert the first parsed table into a Block Kit table attachment.
 * Any additional tables are silently dropped here — the caller is
 * responsible for falling back (e.g. rendering them as code fences
 * in the text stream).
 *
 * @returns A single-element array containing one attachment with
 *          one table block, or an empty array when there are no tables.
 *
 * @see https://docs.slack.dev/reference/block-kit/blocks/table-block/
 */
export function markdownTablesToBlockKitAttachment(
  tables: MarkdownTableData[],
): { blocks: SlackTableBlock[] }[] {
  if (!tables.length) {
    return [];
  }
  // Slack only permits one table per message; take the first.
  const block = markdownTableToBlockKit(tables[0]!);
  return [{ blocks: [block] }];
}

/**
 * Return the count of tables that couldn't be sent as Block Kit
 * (i.e. tables beyond the first, which must be rendered differently).
 */
export function countOverflowTables(tables: MarkdownTableData[]): number {
  return Math.max(0, tables.length - 1);
}
