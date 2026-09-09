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
// rendering while strays stay confined to their own cell.
//
// Reference links are the one exception: the renderer matches their labels against the
// document's definitions by identifier, and an escaped delimiter inside a label breaks
// that match. Approximating the parser's reference grammar locally (label folding,
// containers, multiline labels) keeps leaking edge cases, so cells that could contain
// a reference pass through byte-identical to main instead; the stray-delimiter defect
// stays open in those cells by design.
const CELL_DELIMITER_CANDIDATES = /[*_`]/u;

type PositionedNode = {
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
    // An autolink's text child carries the destination itself, so escaping a
    // delimiter there rewrites the URL or email the renderer matches against.
    // Autolinks are the only link form whose source starts with `<`; inline
    // and reference links keep prose text and stay escapable.
    if (node.type === "link" && start !== undefined && markdown[start] === "<") {
      return;
    }
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
 * Owns literal cell delimiters, except when the cell could hold a reference link.
 * A reference needs `[` in the cell and a definition (`[label]: destination`, which
 * always contains `]:`) somewhere in the document; either one missing proves the
 * cell is reference-free. Matching that grammar more precisely is the renderer's
 * job, so possible-reference cells keep their exact source bytes.
 */
function ownCellDelimiters(markdown: string, referencesPossible: boolean): string {
  if (!CELL_DELIMITER_CANDIDATES.test(markdown)) {
    return markdown;
  }
  if (referencesPossible && markdown.includes("[")) {
    return markdown;
  }
  const ranges = literalTextRanges(markdown);
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
  referencesPossible: boolean,
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
    markdown: ownCellDelimiters(source.headers[column] ?? "", referencesPossible),
  }));
  const rows = table.rows.map((row, index) =>
    row.map((text, column) => ({
      text,
      markdown: ownCellDelimiters(source.rows[index]?.[column] ?? "", referencesPossible),
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
  // Every reference definition contains `]:`; without that shape no reference in
  // any cell can resolve, so bracket-bearing cells are provably reference-free.
  const referencesPossible = /\]:/u.test(markdown);
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    const rendered = renderTableSource(table, mode, referencesPossible).replaceAll(
      "\n",
      "\n" + source.prefix,
    );
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
