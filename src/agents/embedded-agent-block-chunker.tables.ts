import { isSafeFenceBreak, type FenceSpan } from "../../packages/markdown-core/src/fences.js";
import { findMarkdownTableRanges } from "../../packages/markdown-core/src/ir.js";

export type BreakSpan = Pick<FenceSpan, "start" | "end">;

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
    // Rows keep arriving until a blank line closes the table, a trailing header
    // line is not a table until its delimiter row arrives, and the unfinished
    // last line (for example a bare "> ") may still become a row.
    const lastLineStart = source.lastIndexOf("\n") + 1;
    let pendingStart = source.slice(lastLineStart).includes("|") ? lastLineStart : source.length;
    let lineEnd = lastLineStart - 1;
    while (lineEnd > 0) {
      const lineStart = source.lastIndexOf("\n", lineEnd - 1) + 1;
      if (!source.slice(lineStart, lineEnd).includes("|")) {
        break;
      }
      pendingStart = lineStart;
      lineEnd = lineStart - 1;
    }
    const last = tables.at(-1);
    const trailing = last ? source.slice(last.end) : "";
    if (last && ((!trailing.trim() && !/\n[ \t]*\n/.test(trailing)) || pendingStart <= last.end)) {
      last.end = source.length;
    } else if (pendingStart < source.length) {
      tables.push({ start: pendingStart, end: source.length });
    }
  }
  // An open span also covers the line break after its last row; only that break
  // is excluded from the table's size.
  return tables.filter(
    (table) =>
      source.slice(table.start, table.end).replace(/\r?\n[ \t]*$/, "").length <= maxChars &&
      isSafeFenceBreak(fenceSpans, table.start),
  );
}
