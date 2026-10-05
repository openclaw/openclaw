// Feishu plugin module answers which tables a card can draw and how many it may hold.
import { getMarkdownTableSource } from "openclaw/plugin-sdk/markdown-table-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";

/** Feishu allows at most five table components per static interactive card. */
const FEISHU_CARD_TABLE_LIMIT = 5;

// A source line that opens a list. Our parser reads `- Name | Role` as a table
// whose first cell is `- Name`; the card renderer reads the same line as a list
// item and finds no table under it. This is tested against the original line
// rather than the parsed cell, because `| - Name | Role |`, an escaped marker,
// an inline-code marker and an emphasized marker all parse to the cell
// `- Name` while none of them opens a list.
const CARD_TABLE_LIST_OPENER = /^\s*(?:[-*+]|\d+[.)])\s/u;

/**
 * A card carries a table as one component, and the card chunker cuts on lines without
 * repeating the header and its delimiter, so every card after the first shows those rows
 * as raw pipes. A table that does not fit one card belongs on the post path, which renders
 * it as a fenced block that survives the cut. One rule, asked at every place that promotes
 * text to a card.

/**
 * Counts the tables in `text` twice: how many the parser finds, and how many of
 * those are eligible to be drawn there.
 *
 * The two numbers differ because the card renderer's Markdown is not ours. It
 * does not descend into a blockquote, and it claims a leading list marker for a
 * list. In both cases it draws nothing at all for the table rather than falling
 * back to its text, so the rows leave the message. The post path renders both
 * shapes, because it converts them to a fenced block first.
 */
function countMarkdownTables(text: string): { total: number; drawable: number } {
  // GFM table headers require a literal pipe.
  if (!text.includes("|")) {
    return { total: 0, drawable: 0 };
  }
  const { tables } = markdownToIRWithMeta(text, { tableMode: "block" });
  let drawable = 0;
  for (const table of tables) {
    const source = getMarkdownTableSource(table);
    if (!source || source.prefix) {
      continue;
    }
    const headerLine = text.slice(source.start).split("\n", 1)[0] ?? "";
    if (CARD_TABLE_LIST_OPENER.test(headerLine)) {
      continue;
    }
    drawable += 1;
  }
  return { total: tables.length, drawable };
}

export function withinCardTableLimit(text: string): boolean {
  // Counts every table, not just the drawable ones: staying under the component
  // limit by ignoring tables is the wrong kind of cheap.
  return countMarkdownTables(text).total <= FEISHU_CARD_TABLE_LIMIT;
}

/**
 * Whether the parser finds a table in this text at all. `off` uses this to keep
 * a raw table off a card, where the card renderer would parse its pipes.
 */
export function hasCardMarkdownTable(text: string): boolean {
  return countMarkdownTables(text).total > 0;
}

/**
 * Whether this text carries a table the card renderer is not expected to draw.
 * Every path that can commit a card has to ask this, not only ordinary send
 * routing, or the rows leave the message on whichever path skipped it.
 */
export function hasUndrawableCardTable(text: string): boolean {
  const { total, drawable } = countMarkdownTables(text);
  return total > drawable;
}

/**
 * Fenced code promotes a message to a card. A table promotes it only when the
 * card renderer is expected to draw every table in it, since one it does not draw
 * is dropped from the message instead of degrading.
 */
export function shouldUseCard(text: string, nativeTables: boolean): boolean {
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  if (!nativeTables) {
    return false;
  }
  const { total, drawable } = countMarkdownTables(text);
  return total > 0 && drawable === total;
}

export function feishuCardWithinTableLimit(card: Record<string, unknown>): boolean {
  let remaining = FEISHU_CARD_TABLE_LIMIT;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every(visit);
    }
    if (!isRecord(value)) {
      return true;
    }
    if (value.tag === "markdown" && typeof value.content === "string") {
      remaining -= countMarkdownTables(value.content).total;
    }
    return remaining >= 0 && Object.values(value).every(visit);
  };
  return visit(card);
}
