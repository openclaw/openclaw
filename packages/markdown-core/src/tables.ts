import { expectDefined } from "@openclaw/normalization-core/expect";
import { buildCodeSpanIndex } from "./code-spans.js";
import { getMarkdownTableSource, markdownToIRWithMeta, type MarkdownTableMeta } from "./ir.js";
import { renderMarkdownCodeTable, renderMarkdownTableBullets } from "./table-layout.js";
import type { MarkdownTableMode } from "./types.js";

// The bullets render path reassembles raw cell Markdown next to generated `**` markers
// and `• ` prefixes. A bare emphasis or code delimiter inside one cell can then pair
// with those generated markers or with a delimiter in a later cell, shifting emphasis
// and code-span boundaries across the whole bullet block (inline code and emphasis
// both span softbreaks within the rendered paragraph). Escaping bare delimiters in the
// source cell markdown keeps every stray delimiter literal at its own position. Authored
// spans are already parsed into the IR at this point and authored escapes keep their
// backslash, so ordinary cells stay byte-identical.
const BARE_CELL_DELIMITERS = /(?<!\\)[*_`]/gu;

/**
 * Finds code-span coverage that only includes closed spans: the scanner reports an
 * open-at-EOF run as covered, but that run has no closer in this markdown, so it is a
 * stray whose delimiters must still be escaped.
 */
function closedCodeSpanLookup(markdown: string): (offset: number) => boolean {
  const { isInside, inlineState } = buildCodeSpanIndex(markdown);
  const spans: Array<[number, number]> = [];
  let start: number | undefined;
  for (let offset = 0; offset <= markdown.length; offset += 1) {
    const inside = offset < markdown.length && isInside(offset);
    if (inside && start === undefined) {
      start = offset;
    }
    if (!inside && start !== undefined) {
      spans.push([start, offset]);
      start = undefined;
    }
  }
  const last = spans.at(-1);
  const kept = inlineState.open && last && last[1] === markdown.length ? spans.slice(0, -1) : spans;
  return (offset) => kept.some(([from, to]) => offset >= from && offset < to);
}

function ownCellDelimiters(markdown: string): string {
  if (!/[*_`]/.test(markdown)) {
    return markdown;
  }
  // Closed code spans own their delimiters, and `\\*` or `` \` `` are not delimiters at
  // all. Everything else is an orphan on this embedded surface.
  const isInsideClosedSpan = closedCodeSpanLookup(markdown);
  return markdown.replaceAll(BARE_CELL_DELIMITERS, (delimiter, offset: number) =>
    isInsideClosedSpan(offset) ? delimiter : `\\${delimiter}`,
  );
}

function renderTableSource(
  table: MarkdownTableMeta,
  mode: Exclude<MarkdownTableMode, "off">,
): string {
  if (mode !== "bullets") {
    const text = renderMarkdownCodeTable(table.headers, table.rows);
    let fenceLength = 3;
    for (const run of text.matchAll(/`+/g)) {
      fenceLength = Math.max(fenceLength, run[0].length + 1);
    }
    const fence = "`".repeat(fenceLength);
    return `${fence}\n${text}${fence}`;
  }
  const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
  const headers = table.headers.map((text, column) => ({
    text,
    markdown: ownCellDelimiters(source.headers[column] ?? ""),
  }));
  const rows = table.rows.map((row, index) =>
    row.map((text, column) => ({
      text,
      markdown: ownCellDelimiters(source.rows[index]?.[column] ?? ""),
    })),
  );
  let rendered = "";
  renderMarkdownTableBullets(
    headers,
    rows,
    (text) => {
      rendered += text;
    },
    (cell, rowLabel) => {
      rendered += rowLabel ? `**${cell.markdown}**` : cell.markdown;
    },
  );
  return rendered.replace(/\n+$/u, "");
}

/** Convert only parsed table ranges; unrelated Markdown retains its original source bytes. */
export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === "off" || !markdown.includes("|")) {
    return markdown;
  }
  const { tables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    tableMode: "block",
  });
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    const rendered = renderTableSource(table, mode).replaceAll("\n", "\n" + source.prefix);
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
