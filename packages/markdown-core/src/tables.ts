import { expectDefined } from "@openclaw/normalization-core/expect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { getMarkdownTableSource, markdownToIRWithMeta, type MarkdownTableMeta } from "./ir.js";
import { renderMarkdownCodeTable, renderMarkdownTableBullets } from "./table-layout.js";
import type { MarkdownTableMode } from "./types.js";

// The bullets render path reassembles raw cell Markdown next to generated `**` markers
// and `• ` prefixes. A delimiter left literal in one cell can pair with those generated
// markers or with a delimiter in a later cell, shifting emphasis and code-span boundaries
// across the whole bullet block (both span softbreaks within the rendered paragraph).
// The inline parser decides which delimiters are literal: authored emphasis, code spans,
// and links keep their delimiters (their syntax lives in non-text nodes), while text
// nodes own the literal `*`/`_`/`` ` `` runs. Escaping only those keeps authored markup
// rendering while strays stay confined to their own cell. Reference links keep their
// source too: cells parse in isolation, so the document's reference definitions are
// appended to the parse input and the parser itself resolves each reference into a
// link node whose delimiters live outside text ranges.
const CELL_DELIMITER_CANDIDATES = /[*_`]/u;

type PositionedNode = {
  identifier?: string;
  type?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: PositionedNode[];
};

/**
 * Ranges of cell source that the inline parser owns as literal text. Delimiters inside
 * them are orphans on this embedded surface; delimiters outside them belong to parsed
 * emphasis, code spans, or links and must survive rendering.
 *
 * `definitionSuffix` carries the document's reference definitions (whitespace-flattened,
 * joined by newlines) so references resolve exactly as the channel renderer resolves
 * them — multiline labels, padded labels, and Unicode-whitespace variants included —
 * instead of approximating the parser's reference grammar with a local scanner.
 * Whitespace is flattened to ordinary spaces in the parse copy only; the substitution
 * preserves UTF-16 offsets 1:1, keeps whitespace semantics for emphasis flanking, and
 * matches markdown-it's `\s`-based identifier folding. Classification always applies
 * to the original cell bytes.
 */
function literalTextRanges(markdown: string, definitionSuffix: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: PositionedNode): void => {
    // Reference labels must keep their exact source bytes: the renderer matches
    // them against definition identifiers, and an escaped delimiter inside the
    // label text breaks that match. Inline links/images stay escapable — their
    // label text renders identically whether or not a delimiter is escaped.
    if (node.type === "linkReference" || node.type === "imageReference") {
      return;
    }
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  const source = markdown.replace(/\s/gu, " ");
  const input = definitionSuffix === "" ? source : `${source}\n\n${definitionSuffix}`;
  // SAFETY: fromMarkdown returns the mdast Root; nodes structurally match PositionedNode.
  visit(fromMarkdown(input) as PositionedNode);
  // The appended definitions start beyond the cell source; their ranges never apply.
  return ranges.filter(([, to]) => to <= markdown.length);
}

/**
 * Source slices of every reference definition in the document. Definitions may nest
 * in block quotes or list items and their labels may span lines, so the mdast parse —
 * not a line-anchored precheck — decides what is a definition; keeping the exact
 * source lets the cell parse re-resolve references with the parser's own grammar.
 */
function collectReferenceDefinitions(markdown: string): string[] {
  const definitions: string[] = [];
  const visit = (node: PositionedNode): void => {
    if (node.type === "definition") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        definitions.push(markdown.slice(start, end));
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  // SAFETY: fromMarkdown returns the mdast Root; nodes structurally match PositionedNode.
  visit(fromMarkdown(markdown) as PositionedNode);
  return definitions;
}

function ownCellDelimiters(markdown: string, definitionSuffix: string): string {
  if (!CELL_DELIMITER_CANDIDATES.test(markdown)) {
    return markdown;
  }
  const ranges = literalTextRanges(markdown, definitionSuffix);
  const isLiteral = (offset: number): boolean =>
    ranges.some(([from, to]) => offset >= from && offset < to);
  let owned = "";
  let offset = 0;
  while (offset < markdown.length) {
    const char = markdown[offset];
    if (char === "\\") {
      // A backslash escapes the following byte; keep the pair verbatim so
      // already-escaped delimiters and literal backslashes stay untouched.
      owned += markdown.slice(offset, offset + 2);
      offset += 2;
      continue;
    }
    const isDelimiter = char === "*" || char === "_" || char === "`";
    owned += isDelimiter && isLiteral(offset) ? `\\${char}` : char;
    offset += 1;
  }
  return owned;
}

function renderTableSource(
  table: MarkdownTableMeta,
  mode: Exclude<MarkdownTableMode, "off">,
  definitionSuffix: string,
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
    markdown: ownCellDelimiters(source.headers[column] ?? "", definitionSuffix),
  }));
  const rows = table.rows.map((row, index) =>
    row.map((text, column) => ({
      text,
      markdown: ownCellDelimiters(source.rows[index]?.[column] ?? "", definitionSuffix),
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
  // Gate the definition-collecting parse on any `[…]:` shape: labels may span lines
  // (so the brackets may contain newlines) and definitions may nest in block quotes
  // or list items (so no line anchoring). A false positive only costs one parse.
  // The suffix is prepared once and reused for every cell parse on this document.
  const definitionSuffix = /\[[^\]]+\]:/u.test(markdown)
    ? collectReferenceDefinitions(markdown)
        .map((definition) => definition.replace(/\s/gu, " "))
        .join("\n")
    : "";
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    const rendered = renderTableSource(table, mode, definitionSuffix).replaceAll(
      "\n",
      "\n" + source.prefix,
    );
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
