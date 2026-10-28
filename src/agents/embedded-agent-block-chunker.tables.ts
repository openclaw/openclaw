import { isSafeFenceBreak, type FenceSpan } from "../../packages/markdown-core/src/fences.js";
import { findMarkdownTableRanges } from "../../packages/markdown-core/src/ir.js";

export type BreakSpan = Pick<FenceSpan, "start" | "end">;
type TableSpan = BreakSpan & { header?: string };

export type BreakSpans = {
  fences: FenceSpan[];
  tables: TableSpan[];
  /** Fences and tables, sorted by start. */
  unsafe: BreakSpan[];
};

function canRenderIndependently(source: string, table: BreakSpan): boolean {
  if (table.start === 0) {
    return true;
  }
  const standalone = findMarkdownTableRanges(source.slice(table.start, table.end))[0];
  return standalone?.start === 0 && standalone.end === table.end - table.start;
}

function continuationHeader(source: string, table: BreakSpan, maxChars: number): string {
  if (!canRenderIndependently(source, table)) {
    return "";
  }
  const headerEnd = source.indexOf("\n", source.indexOf("\n", table.start) + 1) + 1;
  const header = source.slice(table.start, headerEnd);
  // Rows that cannot fit beside their header retain the existing hard-break fallback.
  return headerEnd > table.start &&
    headerEnd < table.end &&
    header.length < maxChars &&
    source
      .slice(headerEnd, table.end)
      .split("\n")
      .every((row) => header.length + row.length <= maxChars)
    ? header
    : "";
}

/**
 * Keep fitting tables whole and split larger tables only at complete rows.
 * Their headers frame each continuation so channel renderers can parse it.
 */
export function findTableSpans(
  source: string,
  fenceSpans: FenceSpan[],
  maxChars: number,
  streaming: boolean,
): TableSpan[] {
  const parsed: TableSpan[] = findMarkdownTableRanges(source);
  const fits = (table: BreakSpan) =>
    table.end - table.start <= maxChars && isSafeFenceBreak(fenceSpans, table.start);
  const tables = parsed.filter((table) => {
    if (fits(table)) {
      return true;
    }
    if (!isSafeFenceBreak(fenceSpans, table.start)) {
      return false;
    }
    const header = continuationHeader(source, table, maxChars);
    if (!header) {
      return false;
    }
    table.header = header;
    return true;
  });
  if (!streaming || !source.includes("|")) {
    return tables;
  }
  const last = parsed.at(-1);
  if (last && !/\n[^\n]*\n/.test(source.slice(last.end))) {
    // Until a full line follows the table, the unfinished line after it (even
    // a bare "> ") may still become a row. It doesn't count toward the fit
    // until it does, when the parser includes it in the table.
    if (tables.at(-1) === last && !last.header) {
      last.end = source.length;
    }
    return tables;
  }
  // A header line is not a table until its delimiter row arrives.
  const lineStart = source.lastIndexOf("\n") + 1;
  const line = source.slice(lineStart);
  const headerStart = source.lastIndexOf("\n", lineStart - 2) + 1;
  const pending = {
    start:
      lineStart > 0 &&
      /^[\s>|:-]*$/.test(line) &&
      source.slice(headerStart, lineStart).includes("|")
        ? headerStart
        : line.includes("|")
          ? lineStart
          : source.length,
    end: source.length,
  };
  if (pending.start < source.length && fits(pending)) {
    tables.push(pending);
  }
  return tables;
}

/** A replayed delivery boundary may end the visible source in the middle of a table. */
export function findTableContinuationAtBoundary(source: string, maxChars: number): string {
  const table = findMarkdownTableRanges(source).at(-1);
  return table && /^\r?\n?$/.test(source.slice(table.end))
    ? continuationHeader(source, table, maxChars)
    : "";
}

/** Keep a synthetic header only while the pending source can still continue its table. */
export function resolveTableContinuation(header: string, pending: string, force: boolean): string {
  if (!header) {
    return "";
  }
  const table = findMarkdownTableRanges(header + pending)[0];
  return (table?.start === 0 && table.end > header.length) || (!force && !pending.includes("\n"))
    ? header
    : "";
}

/** Framing is excluded from source accounting, just like a reopened code fence. */
export function findTableContinuationHeader(
  source: string,
  cut: number,
  nextStart: number,
  tables: TableSpan[],
  streaming: boolean,
): string {
  return (
    tables.find(
      (table) =>
        table.header &&
        cut > table.start + table.header.length &&
        source.charAt(cut) === "\n" &&
        ((cut < table.end && nextStart <= table.end) ||
          (cut >= table.end && streaming && /^\r?\n?$/.test(source.slice(table.end)))),
    )?.header ?? ""
  );
}

/**
 * Break before a table, between rows of a larger table, or wait for a fitting
 * streaming table to end. Returns undefined when no table owns the cut.
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
  if (table.header) {
    const lineBreak = buffer.lastIndexOf("\n", windowLength);
    return lineBreak > 0 && offset + lineBreak > table.start + table.header.length
      ? lineBreak
      : undefined;
  }
  // Only a streaming table's span reaches the buffer end; until the line after
  // it starts, its last row may still be arriving.
  return table.start <= offset &&
    table.end === offset + buffer.length &&
    /^\r?\n?$/.test(buffer.slice(windowLength))
    ? -1
    : undefined;
}
