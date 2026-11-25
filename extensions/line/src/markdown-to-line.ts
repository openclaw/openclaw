import type { messagingApi } from "@line/bot-sdk";
import {
  chunkTextRanges,
  markdownToIRWithMeta,
  stripMarkdown,
  type MarkdownIR,
  type MarkdownStyle,
  type MarkdownStyleSpan,
  type MarkdownTableCell,
  type MarkdownTableMeta,
} from "openclaw/plugin-sdk/text-chunking";
import { cardBox, cardText } from "./flex-templates/common.js";
import { fitsLineFlexBubble, toFlexMessage } from "./flex-templates/message.js";
import { createReceiptCard } from "./flex-templates/schedule-cards.js";
import type { FlexBubble } from "./flex-templates/types.js";

type FlexMessage = messagingApi.FlexMessage;
type FlexComponent = messagingApi.FlexComponent;
type FlexSpan = messagingApi.FlexSpan;

type LineTextPart = { text: string; table?: boolean };
type LineTextSegment = { type: "text"; text: string; parts?: LineTextPart[] };
type LineMessageSegment = LineTextSegment | { type: "flex"; message: FlexMessage };

/** Prose uses LINE's Markdown chunker. A projected table needs contiguous, lossless slices. */
export function chunkLineText(
  segment: LineTextSegment,
  limit: number,
  chunkMarkdown: (text: string, limit: number) => string[],
): Array<{ text: string; pushText?: string }> {
  if (!segment.parts) {
    return chunkMarkdown(segment.text, limit).map((text) => ({ text }));
  }
  const chunks: Array<{ text: string; pushText?: string }> = [];
  let text = "";
  let firstTable = Infinity;
  let lastTable = 0;
  const flush = () => {
    // The raw push sender trims prose. Limit that trim to bytes outside the prepared table.
    const start = Math.min(text.length - text.trimStart().length, firstTable);
    const end = Math.max(text.trimEnd().length, lastTable);
    const pushText = text.slice(start, end);
    if (pushText) {
      chunks.push(pushText === text.trim() ? { text } : { text, pushText });
    }
    text = "";
    firstTable = Infinity;
    lastTable = 0;
  };
  for (const part of segment.parts) {
    const pieces = part.table
      ? chunkTextRanges(part.text, { limit, mode: "preferred" }).map(({ start, end }) =>
          part.text.slice(start, end),
        )
      : chunkMarkdown(part.text, limit);
    for (const [index, piece] of pieces.entries()) {
      if ((!part.table && index > 0) || (limit > 0 && text.length + piece.length > limit)) {
        flush();
      }
      if (part.table) {
        firstTable = Math.min(firstTable, text.length);
        lastTable = text.length + piece.length;
      }
      text += piece;
    }
  }
  flush();
  return chunks;
}

const LINE_MARKDOWN_OPTIONS = {
  assistantTranscriptRoleHeaders: true,
  autolink: false,
  blockquotePrefix: "",
  headingStyle: "none",
  horizontalRuleText: "",
  linkify: false,
  preserveSourceBlockSpacing: true,
} as const;
const TRANSCRIPT_ROLE_PREFIX = "[assistant-authored transcript] ";
// How much code one Flex card shows. Nothing in LINE caps a Flex text this low —
// it is the card's own readable budget — so a longer block is delivered as text
// rather than cut down to it.
const LINE_FLEX_CODE_CARD_MAX_CHARS = 2000;

function parseLineMarkdown(text: string, tableMode: "block" | "bullets" = "block") {
  return markdownToIRWithMeta(text, { ...LINE_MARKDOWN_OPTIONS, tableMode });
}

type PlainTextInsertion =
  | { position: number; text: string }
  | { position: number; tableText: string; preserveTableSpaces: boolean }
  | { position: number; message: FlexMessage };

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

/** A link shows its href after the label unless the label already is that address. */
function linkAddsHref(rawLabel: string, href: string): boolean {
  const label = rawLabel.trim();
  return Boolean(href && label && label !== href && `mailto:${label}` !== href);
}

function trimOutsideInlineCode(
  text: string,
  ir: MarkdownIR,
  codeSpans: MarkdownStyleSpan[],
): string {
  const first = codeSpans[0];
  const last = codeSpans.at(-1);
  if (!first || !last) {
    return text.trim();
  }
  // Underline tags disappear from the projection. Only whitespace outside code can be padding.
  const before = ir.text.slice(0, first.start).replace(/<\/?u>/gi, "");
  const after = ir.text.slice(last.end).replace(/<\/?u>/gi, "");
  const start = Math.min(before.length, text.length - text.trimStart().length);
  const end = text.length - Math.min(after.length, text.length - text.trimEnd().length);
  return text.slice(start, end);
}

function projectPlainText(
  ir: MarkdownIR,
  omitted: MarkdownStyleSpan[] = [],
  additionalInsertions: PlainTextInsertion[] = [],
  onSegment?: (segment: LineMessageSegment) => void,
): string {
  const insertions: PlainTextInsertion[] = [...additionalInsertions];
  for (const link of ir.links) {
    if (omitted.some((range) => rangesOverlap(range, link))) {
      continue;
    }
    const href = link.href.trim();
    if (linkAddsHref(ir.text.slice(link.start, link.end), href)) {
      insertions.push({ position: link.end, text: ` (${href})` });
    }
  }
  for (const annotation of ir.annotations ?? []) {
    if (
      annotation.type === "assistant_transcript_role" &&
      !omitted.some((range) => rangesOverlap(range, annotation))
    ) {
      insertions.push({
        position: annotation.start,
        text: TRANSCRIPT_ROLE_PREFIX,
      });
    }
  }
  const inlineCodeSpans = ir.styles.filter(
    (span) => span.style === "code" && !omitted.some((range) => rangesOverlap(range, span)),
  );
  for (const span of inlineCodeSpans) {
    const code = ir.text.slice(span.start, span.end);
    if (
      stripMarkdown(code, { assistantTranscriptRoleHeaders: true }).startsWith(
        TRANSCRIPT_ROLE_PREFIX,
      )
    ) {
      insertions.push({ position: span.start, text: TRANSCRIPT_ROLE_PREFIX });
    }
  }
  insertions.sort((left, right) => left.position - right.position);

  const underlineTags = [...ir.text.matchAll(/<\/?u>/gi)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(
      (tag) =>
        !inlineCodeSpans.some((span) => rangesOverlap(tag, span)) &&
        !omitted.some((span) => rangesOverlap(tag, span)),
    );
  const removed = [...omitted, ...underlineTags].toSorted(
    (left, right) => left.start - right.start,
  );

  let output = "";
  let parts: LineTextPart[] = [];
  const flushText = () => {
    const tail = parts.length ? output.trimEnd() : output.trim();
    if (parts.length && tail) {
      parts.push({ text: tail });
    }
    const text = parts.length ? parts.map((part) => part.text).join("") : tail;
    if (text) {
      onSegment?.({ type: "text", text, ...(parts.some((part) => part.table) ? { parts } : {}) });
    }
    output = "";
    parts = [];
  };
  let cursor = 0;
  let insertionIndex = 0;
  const appendRange = (end: number) => {
    while (insertionIndex < insertions.length) {
      const insertion = insertions[insertionIndex];
      if (!insertion || insertion.position > end) {
        break;
      }
      if (insertion.position >= cursor) {
        output += ir.text.slice(cursor, insertion.position);
        if ("text" in insertion) {
          output += insertion.text;
        } else if ("tableText" in insertion) {
          // Trim surrounding layout without trimming the first or last cell of a table.
          output += "\n\n";
          const preceding = parts.length ? output : output.trimStart();
          if (preceding) {
            parts.push({ text: preceding });
          }
          if (insertion.tableText) {
            parts.push({ text: insertion.tableText, table: insertion.preserveTableSpaces });
          }
          output = "\n\n";
        } else if (onSegment) {
          flushText();
          onSegment({ type: "flex", message: insertion.message });
        }
        cursor = insertion.position;
      }
      insertionIndex += 1;
    }
    output += ir.text.slice(cursor, end);
    cursor = end;
  };

  for (const range of removed) {
    appendRange(range.start);
    cursor = Math.max(cursor, range.end);
    while (
      insertionIndex < insertions.length &&
      (insertions[insertionIndex]?.position ?? cursor) < cursor
    ) {
      insertionIndex += 1;
    }
  }
  appendRange(ir.text.length);
  if (onSegment) {
    flushText();
    return "";
  }
  return trimOutsideInlineCode(output, ir, inlineCodeSpans);
}

type RenderedCell = {
  text: string;
  contents?: FlexSpan[];
  hasMarkup: boolean;
};

function renderTableCell(cell: MarkdownTableCell): RenderedCell {
  if (!cell.text) {
    return { text: "-", hasMarkup: false };
  }

  const codeSpans = cell.styles.filter((span) => span.style === "code");
  const tags = [...cell.text.matchAll(/<\/?u>/gi)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      closing: match[0][1] === "/",
    }))
    .filter((tag) => !codeSpans.some((span) => rangesOverlap(tag, span)));
  const boundaries = new Set([0, cell.text.length]);
  for (const style of cell.styles) {
    boundaries.add(style.start);
    boundaries.add(style.end);
  }
  for (const link of cell.links) {
    boundaries.add(link.end);
  }
  for (const tag of tags) {
    boundaries.add(tag.start);
    boundaries.add(tag.end);
  }
  const sortedBoundaries = [...boundaries].toSorted((left, right) => left - right);
  const spans: FlexSpan[] = [];
  let underlineDepth = 0;
  let hasMarkup = false;

  const appendSpan = (span: FlexSpan) => {
    const previous = spans.at(-1);
    if (
      previous &&
      previous.weight === span.weight &&
      previous.style === span.style &&
      previous.decoration === span.decoration
    ) {
      previous.text = `${previous.text ?? ""}${span.text ?? ""}`;
    } else {
      spans.push(span);
    }
  };

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index];
    const end = sortedBoundaries[index + 1];
    if (start === undefined || end === undefined) {
      continue;
    }
    const tag = tags.find((candidate) => candidate.start === start);
    if (tag) {
      underlineDepth += tag.closing ? -1 : 1;
      hasMarkup = true;
      continue;
    }
    const text = cell.text.slice(start, end);
    if (text) {
      const active = new Set<MarkdownStyle>(
        cell.styles
          .filter((style) => style.start <= start && style.end >= end)
          .map((style) => style.style),
      );
      const weight = active.has("bold") ? "bold" : undefined;
      const style = active.has("italic") ? "italic" : undefined;
      const decoration = active.has("strikethrough")
        ? "line-through"
        : underlineDepth > 0
          ? "underline"
          : undefined;
      hasMarkup ||= weight !== undefined || style !== undefined || decoration !== undefined;
      appendSpan({ type: "span", text, weight, style, decoration });
    }
    for (const link of cell.links.filter((candidate) => candidate.end === end)) {
      const href = link.href.trim();
      if (linkAddsHref(cell.text.slice(link.start, link.end), href)) {
        appendSpan({ type: "span", text: ` (${href})` });
        hasMarkup = true;
      }
    }
  }

  const renderedText = trimOutsideInlineCode(
    spans.map((span) => span.text ?? "").join(""),
    cell,
    codeSpans,
  );
  return {
    text: renderedText || "-",
    ...(hasMarkup ? { contents: spans } : {}),
    hasMarkup,
  };
}

function convertTableToFlexBubble(table: MarkdownTableMeta): FlexBubble | undefined {
  // Receipt cards keep 12 plain rows; generic and styled layouts keep only 10.
  const requiresPlainCells = table.rowCells.length > 10;
  if (requiresPlainCells && (table.headers.length !== 2 || table.rowCells.length > 12)) {
    return undefined;
  }
  let hasInlineMarkup = false;
  const renderCells = (cells: MarkdownTableCell[]): RenderedCell[] | undefined => {
    const rendered: RenderedCell[] = [];
    for (const cell of cells) {
      const prepared = renderTableCell(cell);
      if (requiresPlainCells && prepared.hasMarkup) {
        return undefined;
      }
      hasInlineMarkup ||= prepared.hasMarkup;
      rendered.push(prepared);
    }
    return rendered;
  };
  const headerCells = renderCells(table.headerCells);
  if (!headerCells) {
    return undefined;
  }
  const rowCells: RenderedCell[][] = [];
  for (const row of table.rowCells) {
    const cells = renderCells(row);
    if (!cells) {
      return undefined;
    }
    rowCells.push(cells);
  }

  if (table.headers.length === 2 && !hasInlineMarkup) {
    return createReceiptCard({
      title: headerCells.map((cell) => cell.text).join(" / "),
      items: rowCells.map((row) => ({
        name: row[0]?.text ?? "-",
        value: row[1]?.text ?? "-",
      })),
    });
  }

  const renderRow = (
    cells: RenderedCell[],
    textStyle: Pick<messagingApi.FlexText, "color" | "weight">,
    rowStyle: Pick<messagingApi.FlexBox, "paddingBottom" | "margin">,
  ): FlexComponent =>
    cardBox(
      "horizontal",
      cells.map((cell) =>
        cardText(cell.text, {
          contents: cell.contents,
          ...textStyle,
          size: "sm",
          flex: 1,
          wrap: true,
        }),
      ),
      rowStyle,
    );
  const headerRow = renderRow(
    headerCells,
    { weight: "bold", color: "#333333" },
    { paddingBottom: "sm" },
  );
  const dataRows = rowCells.map((row, rowIndex) =>
    renderRow(
      table.headers.map((_, colIndex) => row[colIndex] ?? { text: "-", hasMarkup: false }),
      { color: "#666666" },
      { margin: rowIndex === 0 ? "md" : "sm" },
    ),
  );

  return {
    type: "bubble",
    body: cardBox("vertical", [headerRow, { type: "separator", margin: "sm" }, ...dataRows], {
      paddingAll: "lg",
    }),
  };
}

/** Parse once, route existing block surfaces to Flex, and project the remainder as plain text. */
export function processLineMessage(text: string): LineMessageSegment[] {
  const { ir, tables } = parseLineMarkdown(text);
  const codeSpans = ir.styles.filter((span) => span.style === "code_block");
  const plainTextInsertions: PlainTextInsertion[] = [];

  for (const table of tables) {
    const bubble = convertTableToFlexBubble(table);
    if (!bubble || !fitsLineFlexBubble(bubble)) {
      const hasPaddedCode = (cell: MarkdownTableCell) =>
        cell.styles.some(
          ({ style, start, end }) =>
            style === "code" && /^\s|\s$/u.test(cell.text.slice(start, end)),
        );
      const markdownCell = (cell: MarkdownTableCell) =>
        projectPlainText(cell)
          .replace(/[\\|`*_[\]~<>&]/gu, "\\$&")
          .replace(/\r?\n/gu, " ")
          // Keep code-owned edges through the bullet parse. CommonMark leaves all-space spans intact.
          .replace(
            /^\s+|(?<=\S)\s+$/gu,
            (edge) => "`" + (/[^ ]/u.test(edge) ? ` ${edge} ` : edge) + "`",
          );
      const markdownRow = (cells: MarkdownTableCell[]) =>
        `| ${cells.map(markdownCell).join(" | ")} |`;
      const markdown = [
        markdownRow(table.headerCells),
        `| ${table.headerCells.map(() => "---").join(" | ")} |`,
        ...table.rowCells.map(markdownRow),
      ].join("\n");

      plainTextInsertions.push({
        position: table.placeholderOffset,
        tableText: projectPlainText(parseLineMarkdown(markdown, "bullets").ir),
        preserveTableSpaces:
          table.headerCells.some(hasPaddedCode) ||
          table.rowCells.some((row) => row.some(hasPaddedCode)),
      });
      continue;
    }
    const message = toFlexMessage("Table", bubble);
    plainTextInsertions.push({ position: table.placeholderOffset, message });
  }

  for (const span of codeSpans) {
    const block = {
      ...(span.language ? { language: span.language } : {}),
      code: ir.text.slice(span.start, span.end).trimEnd(),
    };
    // An empty fence has no code to show, and LINE rejects the whole push when a
    // Flex text is blank, so it drops out instead of costing the reply.
    if (!block.code.trim()) {
      continue;
    }
    // A block the card would have to cut is delivered as the text it was written
    // as, the same way an oversized table is: the reader gets all of it, chunked
    // by the ordinary text limit, instead of a card ending in an ellipsis.
    if (block.code.length > LINE_FLEX_CODE_CARD_MAX_CHARS) {
      plainTextInsertions.push({ position: span.start, text: `\n\n${block.code}\n\n` });
      continue;
    }
    const titleText = block.language ? `Code (${block.language})` : "Code";
    plainTextInsertions.push({
      position: span.start,
      message: toFlexMessage("Code", {
        type: "bubble",
        body: cardBox(
          "vertical",
          [
            cardText(titleText, { weight: "bold", size: "sm", color: "#666666" }),
            cardBox(
              "vertical",
              [cardText(block.code, { size: "xs", color: "#333333", wrap: true })],
              {
                backgroundColor: "#F5F5F5",
                paddingAll: "md",
                cornerRadius: "md",
                margin: "sm",
              },
            ),
          ],
          { paddingAll: "lg" },
        ),
      }),
    });
  }

  const segments: LineMessageSegment[] = [];
  projectPlainText(ir, codeSpans, plainTextInsertions, (segment) => segments.push(segment));
  return segments;
}
