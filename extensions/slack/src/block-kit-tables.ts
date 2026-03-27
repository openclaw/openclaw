import type { MarkdownTableData } from "openclaw/plugin-sdk/text-runtime";

/**
 * Slack table blocks support at most 20 columns per table.
 * @see https://slack.dev/python-slack-sdk/api-docs/slack_sdk/models/blocks/blocks.html
 */
const SLACK_MAX_TABLE_COLUMNS = 20;

/**
 * Slack table blocks support at most 100 rows per table (including the header row).
 * @see https://docs.slack.dev/reference/block-kit/blocks/table-block/
 */
const SLACK_MAX_TABLE_ROWS = 100;

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
  const allRows = [...(hasHeaders ? [makeRow(table.headers)] : []), ...table.rows.map(makeRow)];

  // Clamp to Slack's maximum of 100 rows (including header) — excess rows are silently dropped.
  const rows = allRows.slice(0, SLACK_MAX_TABLE_ROWS);

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

/**
 * Generate a meaningful plain-text fallback for table-only messages.
 *
 * Slack uses the top-level `text` field for notifications, accessibility
 * readers, and contexts that don't render Block Kit attachments.  When a
 * message consists solely of table attachments, this function produces a
 * code-block representation of the table data so those contexts still
 * show useful content instead of whitespace.
 */
export function tableFallbackText(tables: MarkdownTableData[]): string {
  if (!tables.length) return " ";

  const parts: string[] = [];
  for (const table of tables) {
    const rows = [table.headers, ...(table.rows ?? [])].filter((r) => r.length > 0);

    if (rows.length === 0) continue;

    // Compute column widths for alignment
    const colCount = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: colCount }, (_, c) =>
      Math.max(...rows.map((r) => (r[c] ?? "").length), 1),
    );

    const lines: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from({ length: colCount }, (_, c) =>
        (rows[i][c] ?? "").padEnd(widths[c]),
      );
      lines.push("| " + cells.join(" | ") + " |");
      // Add separator after header row
      if (i === 0 && table.headers.length > 0) {
        lines.push("| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |");
      }
    }
    parts.push(lines.join("\n"));
  }

  return parts.length > 0 ? parts.join("\n\n") : " ";
}
