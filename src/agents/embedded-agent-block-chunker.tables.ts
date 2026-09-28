import { isSafeFenceBreak, type FenceSpan } from "../../packages/markdown-core/src/fences.js";
import { findMarkdownTableRanges } from "../../packages/markdown-core/src/ir.js";

export type BreakSpan = Pick<FenceSpan, "start" | "end">;

export type BreakSpans = {
  fences: FenceSpan[];
  tables: BreakSpan[];
  /** Fences and whole-kept tables, sorted by start. */
  unsafe: BreakSpan[];
};

/**
 * A table that fits one message stays whole, like a fenced block: channel
 * renderers convert only complete tables, so a split leaves raw Markdown rows.
 */
export function findUnsplittableTableSpans(
  source: string,
  fenceSpans: FenceSpan[],
  maxChars: number,
  streaming: boolean,
): BreakSpan[] {
  const tables = findMarkdownTableRanges(source);
  if (streaming && source.includes("|")) {
    const last = tables.at(-1);
    if (last && !/\n[^\n]*\n/.test(source.slice(last.end))) {
      // Until a full line follows the table, the unfinished line after it (even
      // a bare "> ") may still become a row.
      last.end = source.length;
    } else {
      // A header line is not a table until its delimiter row arrives.
      const lineStart = source.lastIndexOf("\n") + 1;
      const line = source.slice(lineStart);
      const headerStart = source.lastIndexOf("\n", lineStart - 2) + 1;
      const pendingStart =
        lineStart > 0 &&
        /^[\s>|:-]*$/.test(line) &&
        source.slice(headerStart, lineStart).includes("|")
          ? headerStart
          : line.includes("|")
            ? lineStart
            : source.length;
      if (pendingStart < source.length) {
        tables.push({ start: pendingStart, end: source.length });
      }
    }
  }
  // An open span also covers the line break after its last row and any
  // whitespace on the next line; only those are excluded from the table's size.
  return tables.filter(
    (table) =>
      source.slice(table.start, table.end).replace(/\r?\n[ \t]*$/, "").length <= maxChars &&
      isSafeFenceBreak(fenceSpans, table.start),
  );
}

/**
 * Picks the break when a capped window ends inside a table that fits: before
 * the table (below minChars if needed), or -1 to wait while a streaming table
 * exactly fills the window. Returns undefined when no such table is at the cut.
 */
export function findTableBreakIndex(
  buffer: string,
  offset: number,
  windowLength: number,
  spans: BreakSpans,
): number | undefined {
  const cut = offset + windowLength;
  const table = spans.tables.find((span) => span.start < cut && cut <= span.end);
  if (!table) {
    return undefined;
  }
  if (table.start > offset) {
    const tableBreak = buffer.slice(0, table.start - offset).trimEnd().length;
    if (tableBreak > 0 && isSafeFenceBreak(spans.fences, offset + tableBreak)) {
      return tableBreak;
    }
  }
  // Only a streaming table's span reaches the buffer end; until the line after
  // it starts, its last row may still be arriving.
  return table.start <= offset &&
    table.end === offset + buffer.length &&
    /^\r?\n?$/.test(buffer.slice(windowLength))
    ? -1
    : undefined;
}
