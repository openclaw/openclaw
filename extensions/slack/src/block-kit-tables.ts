import type { MarkdownTableData } from "openclaw/plugin-sdk/text-runtime";

/**
 * Slack table blocks support at most 20 columns per table.
 * @see https://slack.dev/python-slack-sdk/api-docs/slack_sdk/models/blocks/blocks.html
 */
const SLACK_MAX_TABLE_COLUMNS = 20;

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
  // Clamp to Slack's maximum of 20 columns — extra columns are silently dropped.
  const columnCount = Math.min(
    Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0),
    SLACK_MAX_TABLE_COLUMNS,
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

  // Only include a header row if there are actual headers with content.
  const hasHeaders = table.headers.some((h) => h.length > 0);
  const rows = [...(hasHeaders ? [makeRow(table.headers)] : []), ...table.rows.map(makeRow)];

  return { type: "table", column_settings, rows };
}

/**
 * Convert parsed tables into Block Kit table attachments.
 *
 * Each table is placed in its own attachment (one table block per
 * attachment) to comply with Slack's constraint that each block
 * surface may contain at most one table block.  Multiple attachments
 * per message are permitted.
 *
 * @see https://docs.slack.dev/reference/block-kit/blocks/table-block/
 */
export function markdownTablesToBlockKitAttachment(
  tables: MarkdownTableData[],
): { blocks: SlackTableBlock[] }[] {
  if (!tables.length) {
    return [];
  }
  // One table per attachment — Slack allows one table block per
  // block surface, but multiple attachments per message.
  return tables.map((table) => ({
    blocks: [markdownTableToBlockKit(table)],
  }));
}
