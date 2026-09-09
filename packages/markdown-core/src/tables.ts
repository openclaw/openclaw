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
// source too: cells parse without the document's definitions, so a reference label
// looks like text unless it is matched against the definitions collected up front.
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
 */
function literalTextRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: PositionedNode): void => {
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
  // SAFETY: fromMarkdown returns the mdast Root; nodes structurally match PositionedNode.
  visit(fromMarkdown(markdown) as PositionedNode);
  return ranges;
}

/**
 * Canonical form for reference identifiers, mirroring micromark's
 * `normalizeIdentifier` (which markdown-it's normalizeReference matches):
 * collapse Markdown whitespace, trim, then lower- AND uppercase. The double
 * case fold is required — `ß`.toLowerCase() stays `ß` while its definition
 * identifier was already folded to `SS`, so lowercasing alone misses valid
 * references.
 */
function normalizeReferenceIdentifier(value: string): string {
  return value
    .replace(/[\t\n\r ]+/gu, " ")
    .replace(/^ | $/gu, "")
    .toLowerCase()
    .toUpperCase();
}

/** Collects the identifiers of reference definitions declared anywhere in the document. */
function collectReferenceIdentifiers(markdown: string): Set<string> {
  const identifiers = new Set<string>();
  const visit = (node: PositionedNode): void => {
    if (node.type === "definition" && typeof node.identifier === "string") {
      identifiers.add(normalizeReferenceIdentifier(node.identifier));
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  // SAFETY: fromMarkdown returns the mdast Root; nodes structurally match PositionedNode.
  visit(fromMarkdown(markdown) as PositionedNode);
  return identifiers;
}

type ReferenceSpan = { end: number; label: string; start: number };

/**
 * Scans cell source for reference-link syntax: `full` `[label][ref]`, `collapsed`
 * `[ref][]`, and `shortcut` `[ref]`. Only spans whose identifier matches a document
 * definition are returned so literal bracket text is never mistaken for a reference.
 */
function referenceSpans(markdown: string, identifiers: Set<string>): ReferenceSpan[] {
  if (identifiers.size === 0) {
    return [];
  }
  const spans: ReferenceSpan[] = [];
  const reference = /\[([^\][\s](?:[^\][]*?)?)\](?:\[([^\][]*)\])?/gu;
  for (const match of markdown.matchAll(reference)) {
    const start = match.index ?? 0;
    const [source, label = "", ref = ""] = match;
    const identifier = normalizeReferenceIdentifier(ref === "" ? label : ref);
    if (!identifiers.has(identifier)) {
      continue;
    }
    spans.push({ start, end: start + source.length, label });
  }
  return spans;
}

function ownCellDelimiters(markdown: string, identifiers: Set<string>): string {
  if (!CELL_DELIMITER_CANDIDATES.test(markdown)) {
    return markdown;
  }
  const ranges = literalTextRanges(markdown);
  const references = referenceSpans(markdown, identifiers);
  const isLiteral = (offset: number): boolean => {
    if (references.some(({ start, end }) => offset >= start && offset < end)) {
      return false;
    }
    return ranges.some(([from, to]) => offset >= from && offset < to);
  };
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
  identifiers: Set<string>,
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
    markdown: ownCellDelimiters(source.headers[column] ?? "", identifiers),
  }));
  const rows = table.rows.map((row, index) =>
    row.map((text, column) => ({
      text,
      markdown: ownCellDelimiters(source.rows[index]?.[column] ?? "", identifiers),
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
  // Gate the definition-collecting parse on any `[…]:` shape: definitions may be
  // nested in block quotes or list items, so a line-anchored precheck would miss
  // documents whose only definitions live inside a container.
  const referenceIdentifiers = /\[[^\]\n]+\]:/u.test(markdown)
    ? collectReferenceIdentifiers(markdown)
    : new Set<string>();
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    const rendered = renderTableSource(table, mode, referenceIdentifiers).replaceAll(
      "\n",
      "\n" + source.prefix,
    );
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
