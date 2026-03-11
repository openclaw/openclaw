/**
 * Feishu Markdown Card builder with native table component support.
 *
 * Feishu's Card JSON markdown element does NOT support standard Markdown table
 * syntax (`| col | col |`).  This module auto-detects Markdown tables in the
 * text and converts them to native Feishu `table` components, while keeping
 * the rest of the content as `markdown` elements.
 *
 * Card JSON 2.0 references:
 * - Structure: https://open.feishu.cn/document/feishu-cards/card-json-v2-structure
 * - Markdown:  https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags
 * - Table:     https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table
 */

type CardElement = Record<string, unknown>;

/** Max rows per Feishu table component (API limit is 1-10). */
const FEISHU_TABLE_PAGE_SIZE_MAX = 10;

/**
 * Regex to match a fenced code block (``` ... ```).
 * Used to build a set of protected spans so that table-shaped lines
 * inside code blocks are never converted to table components.
 */
const FENCED_CODE_BLOCK_RE = /^[ \t]*`{3,}[\s\S]*?^[ \t]*`{3,}/gm;

/**
 * Regex to match a complete Markdown table block:
 *   - header row:    `| Header1 | Header2 |`
 *   - separator row: `|---------|---------|`
 *   - data rows:     `| cell1   | cell2   |`
 */
const MD_TABLE_BLOCK_RE = new RegExp(
  "(?:^[ \\t]*\\|.+\\|[ \\t]*\\n)" + // header row
    "(?:^[ \\t]*\\|[\\s:|-]+\\|[ \\t]*\\n)" + // separator row
    "(?:^[ \\t]*\\|.+\\|[ \\t]*\\n?)+", // one or more data rows
  "gm",
);

/**
 * Collect byte-ranges of all fenced code blocks in the text.
 * Returns sorted, non-overlapping `[start, end)` spans.
 */
function collectCodeBlockSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  FENCED_CODE_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_CODE_BLOCK_RE.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** Check whether `pos` falls inside any of the protected spans. */
function isInsideProtectedSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [start, end] of spans) {
    if (pos >= start && pos < end) {
      return true;
    }
    if (start > pos) {
      break; // spans are sorted, no need to check further
    }
  }
  return false;
}

/**
 * Parse a single Markdown table row into cell values.
 *
 * `| a | b | c |` -> `["a", "b", "c"]`
 */
export function parseTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith("|")) {
    stripped = stripped.slice(1);
  }
  if (stripped.endsWith("|")) {
    stripped = stripped.slice(0, -1);
  }
  return stripped.split("|").map((cell) => cell.trim());
}

/**
 * Convert a Markdown table string into a Feishu Card table component.
 *
 * @returns A Feishu `table` element, or `null` if parsing fails.
 */
export function mdTableToFeishuTable(tableText: string): CardElement | null {
  const lines = tableText
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length < 3) {
    // Need at least: header + separator + 1 data row
    return null;
  }

  const headerLine = lines[0];
  // lines[1] is the separator (---|---), skip it
  const dataLines = lines.slice(2);

  const headers = parseTableRow(headerLine);
  if (headers.length === 0) {
    return null;
  }

  // Build columns
  const columns = headers.map((header, i) => ({
    name: `col_${i}`,
    display_name: header,
    data_type: "text" as const,
    width: "auto" as const,
  }));

  // Build rows
  const rows: Record<string, string>[] = [];
  for (const dataLine of dataLines) {
    const cells = parseTableRow(dataLine);
    if (cells.length === 0) {
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i].name] = i < cells.length ? cells[i] : "";
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    tag: "table",
    page_size: Math.min(rows.length, FEISHU_TABLE_PAGE_SIZE_MAX),
    row_height: "low",
    header_style: {
      text_align: "center",
      text_size: "normal",
      background_style: "grey",
      bold: true,
      lines: 1,
    },
    columns,
    rows,
  };
}

/**
 * Split text into alternating markdown elements and table components.
 *
 * Scans for Markdown table blocks **outside** fenced code blocks.
 * Non-table text becomes `{"tag": "markdown"}` elements; tables become
 * `{"tag": "table"}` components with proper columns/rows structure.
 *
 * Leading/trailing whitespace of each segment is preserved so that
 * indentation-sensitive markdown (e.g. 4-space code blocks) is not
 * mutated.
 */
export function splitTextAndTables(text: string): CardElement[] {
  const elements: CardElement[] = [];
  let lastEnd = 0;

  // Build a set of protected spans (fenced code blocks) to skip
  const codeSpans = collectCodeBlockSpans(text);

  // Reset regex state (global flag)
  MD_TABLE_BLOCK_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MD_TABLE_BLOCK_RE.exec(text)) !== null) {
    // Skip tables that fall inside a fenced code block
    if (isInsideProtectedSpan(match.index, codeSpans)) {
      continue;
    }

    // Text before this table — preserve as-is (no trim)
    const before = text.slice(lastEnd, match.index);
    if (before.trim()) {
      elements.push({ tag: "markdown", content: before });
    }

    // Convert the Markdown table to a Feishu table component
    const tableElement = mdTableToFeishuTable(match[0]);
    if (tableElement) {
      elements.push(tableElement);
    } else {
      // Fallback: keep as markdown (won't render as table but won't lose data)
      elements.push({ tag: "markdown", content: match[0] });
    }

    lastEnd = match.index + match[0].length;
  }

  // Remaining text after last table — preserve as-is (no trim)
  const after = text.slice(lastEnd);
  if (after.trim()) {
    elements.push({ tag: "markdown", content: after });
  }

  // If no elements at all (empty text), return a single empty markdown
  if (elements.length === 0) {
    elements.push({ tag: "markdown", content: "" });
  }

  return elements;
}

/**
 * Check whether text contains Markdown table syntax.
 */
export function hasMarkdownTables(text: string): boolean {
  MD_TABLE_BLOCK_RE.lastIndex = 0;
  return MD_TABLE_BLOCK_RE.test(text);
}

/**
 * Build a Feishu interactive card with markdown content.
 *
 * Uses Card JSON 2.0 format for proper markdown rendering.
 * Automatically converts Markdown tables to native Feishu `table` components
 * since the card markdown element does not support `| col | col |` syntax.
 *
 * @param text - Markdown text (may contain tables)
 * @returns Card JSON 2.0 object
 */
export function buildMarkdownCardWithTables(text: string): Record<string, unknown> {
  const elements = splitTextAndTables(text);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements,
    },
  };
}
