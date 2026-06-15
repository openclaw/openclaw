import type { MarkdownTableMeta } from "openclaw/plugin-sdk/text-chunking";

export type AdaptiveCardTableElement = {
  type: "AdaptiveCard";
  version: string;
  body: unknown[];
};

/**
 * Build an Adaptive Card that renders a markdown table using the
 * Table/TableRow/TableCell elements (Adaptive Card schema 1.5+).
 * Teams desktop/mobile supports these elements natively.
 */
export function buildAdaptiveCardTable(table: MarkdownTableMeta): AdaptiveCardTableElement {
  const columns = table.headers.map(() => ({ width: 1 }));

  const headerRow = {
    type: "TableRow",
    style: "accent",
    cells: table.headers.map((header) => ({
      type: "TableCell",
      items: [
        {
          type: "TextBlock",
          text: header || " ",
          weight: "Bolder",
          wrap: true,
        },
      ],
    })),
  };

  const dataRows = table.rows.map((row) => ({
    type: "TableRow",
    cells: row.map((cell) => ({
      type: "TableCell",
      items: [
        {
          type: "TextBlock",
          text: cell || " ",
          wrap: true,
        },
      ],
    })),
  }));

  return {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "Table",
        gridStyle: "accent",
        firstRowAsHeader: true,
        showGridLines: true,
        columns,
        rows: [headerRow, ...dataRows],
      },
    ],
  };
}

/**
 * Splits markdown text around collected table placeholders, returning
 * alternating text segments and table metadata in document order.
 */
export type AdaptiveTableSegment =
  | { kind: "text"; text: string }
  | { kind: "table"; table: MarkdownTableMeta };

export function splitTextAndTables(
  text: string,
  tables: MarkdownTableMeta[],
): AdaptiveTableSegment[] {
  if (tables.length === 0) {
    return text.trim() ? [{ kind: "text", text }] : [];
  }

  const segments: AdaptiveTableSegment[] = [];
  let cursor = 0;

  for (const table of tables) {
    const before = text.slice(cursor, table.placeholderOffset).trim();
    if (before) {
      segments.push({ kind: "text", text: before });
    }
    segments.push({ kind: "table", table });
    cursor = table.placeholderOffset;
  }

  const trailing = text.slice(cursor).trim();
  if (trailing) {
    segments.push({ kind: "text", text: trailing });
  }

  return segments;
}
