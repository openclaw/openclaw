// Markdown → Bot API 10.2 InputRichBlock[] for Telegram rich messages.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  isAutoLinkedFileRef,
  markdownToIRWithMeta,
  sliceMarkdownIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  type MarkdownStyle,
  type MarkdownTableCell,
  type MarkdownTableMeta,
} from "openclaw/plugin-sdk/text-chunking";
// Runtime-safe: rich-plain-fallback's reverse import of this module is type-only.
import { splitTelegramPlainTextChunks, surrogateSafeChunkEnd } from "./rich-plain-fallback.js";

export type TelegramRichBlocksDegradationReason = "table-ascii";

export type RichText =
  | string
  | RichText[]
  | {
      type: "bold" | "italic" | "strikethrough" | "code" | "spoiler";
      text: RichText;
    }
  | {
      type: "url";
      text: RichText;
      url: string;
    };

export type RichBlockTableCellAlign = "left" | "center" | "right";

export type RichBlockTableCell = {
  text?: RichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align?: RichBlockTableCellAlign;
  valign?: "top" | "middle" | "bottom";
};

export type InputRichBlockParagraph = {
  type: "paragraph";
  text: RichText;
};

export type InputRichBlockHeading = {
  type: "heading";
  text: RichText;
  size: 1 | 2 | 3 | 4 | 5 | 6;
};

export type InputRichBlockPre = {
  type: "pre";
  text: string;
  language?: string;
};

export type InputRichBlockBlockquote = {
  type: "blockquote";
  blocks: InputRichBlock[];
};

export type InputRichBlockTable = {
  type: "table";
  cells: RichBlockTableCell[][];
  is_bordered?: true;
  is_striped?: true;
};

export type InputRichBlock =
  | InputRichBlockParagraph
  | InputRichBlockHeading
  | InputRichBlockPre
  | InputRichBlockBlockquote
  | InputRichBlockTable;

export type TelegramRichBlocksResult = {
  blocks: InputRichBlock[];
  plainText: string;
  degradationReasons: readonly TelegramRichBlocksDegradationReason[];
};

const TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT = 20;

const INLINE_STYLE_RANK: Record<string, number> = {
  spoiler: 0,
  bold: 1,
  italic: 2,
  strikethrough: 3,
  code: 4,
};

const TELEGRAM_RICH_LINK_HREF_RE = /^(?:https?:\/\/|tg:\/\/|mailto:|tel:|#)/i;

type InlineStyleKind = "bold" | "italic" | "strikethrough" | "code" | "spoiler";

type StructuralSegment =
  | { kind: "heading"; start: number; end: number; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "code_block"; start: number; end: number; language?: string }
  | { kind: "blockquote"; start: number; end: number }
  | { kind: "table"; start: number; end: number; table: MarkdownTableMeta };

function isTelegramRichLinkHref(href: string): boolean {
  return TELEGRAM_RICH_LINK_HREF_RE.test(href);
}

function resolveHeadingSize(style: MarkdownStyle): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  switch (style) {
    case "heading_1":
      return 1;
    case "heading_2":
      return 2;
    case "heading_3":
      return 3;
    case "heading_4":
      return 4;
    case "heading_5":
      return 5;
    case "heading_6":
      return 6;
    default:
      return undefined;
  }
}

function isInlineStyle(style: MarkdownStyle): style is InlineStyleKind {
  return (
    style === "bold" ||
    style === "italic" ||
    style === "strikethrough" ||
    style === "code" ||
    style === "spoiler"
  );
}

function normalizeRichText(value: RichText): RichText {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const flattened: RichText[] = [];
    for (const item of value) {
      const normalized = normalizeRichText(item);
      if (normalized === "") {
        continue;
      }
      if (Array.isArray(normalized)) {
        flattened.push(...normalized);
      } else {
        flattened.push(normalized);
      }
    }
    if (flattened.length === 0) {
      return "";
    }
    if (flattened.length === 1) {
      return flattened[0] ?? "";
    }
    return flattened;
  }
  return { ...value, text: normalizeRichText(value.text) };
}

function wrapStyle(kind: InlineStyleKind, text: RichText): RichText {
  return { type: kind, text };
}

type TelegramLinkAction = { kind: "url"; href: string } | { kind: "code" };

function resolveTelegramLinkAction(
  link: MarkdownLinkSpan,
  source: string,
): TelegramLinkAction | null {
  const href = link.href.trim();
  if (!href || link.start === link.end) {
    return null;
  }
  const label = source.slice(link.start, link.end);
  if (isAutoLinkedFileRef(href, label)) {
    // Bare file refs (README.md, openclaw.json) must render as code, not links:
    // Telegram's server-side entity detection would otherwise re-linkify them
    // and show spurious domain previews for TLD-like extensions.
    return { kind: "code" };
  }
  if (!isTelegramRichLinkHref(href)) {
    return null;
  }
  return { kind: "url", href };
}

/**
 * Build nested RichText from IR spans over [rangeStart, rangeEnd).
 * Spans that partially overlap are split at shared boundaries (IR contract).
 */
function irRangeToRichText(ir: MarkdownIR, rangeStart: number, rangeEnd: number): RichText {
  if (rangeEnd <= rangeStart) {
    return "";
  }
  const slice = sliceMarkdownIR(ir, rangeStart, rangeEnd);
  const text = slice.text;
  if (!text) {
    return "";
  }

  const dominantAnnotationRanges = (slice.annotations ?? [])
    .filter((span) => span.type === "assistant_transcript_role")
    .map((span) => ({ start: span.start, end: span.end }));

  const suppressed = (start: number, end: number) =>
    dominantAnnotationRanges.some((range) => start < range.end && end > range.start);

  const styleSpans = slice.styles.filter(
    (span) => isInlineStyle(span.style) && !suppressed(span.start, span.end),
  );
  const annotationSpans = (slice.annotations ?? []).filter(
    (span) => span.type === "assistant_transcript_role",
  );
  const links = slice.links
    .filter((link) => !suppressed(link.start, link.end))
    .flatMap((link) => {
      const action = resolveTelegramLinkAction(link, text);
      return action ? [{ start: link.start, end: link.end, action }] : [];
    });

  const boundaries = new Set<number>([0, text.length]);
  for (const span of styleSpans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const span of annotationSpans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const link of links) {
    boundaries.add(link.start);
    boundaries.add(link.end);
  }
  const points = [...boundaries].toSorted((a, b) => a - b);

  type Active =
    | { kind: "style"; style: InlineStyleKind; end: number }
    | { kind: "annotation"; end: number }
    | { kind: "link"; href: string; end: number };

  const stack: Active[] = [];
  const root: RichText[] = [];
  const frameStack: RichText[][] = [root];

  const pushNode = (node: RichText) => {
    frameStack.at(-1)?.push(node);
  };

  const openStyleNode = (style: InlineStyleKind, end: number) => {
    const container: RichText[] = [];
    pushNode({ type: style, text: container });
    stack.push({ kind: "style", style, end });
    frameStack.push(container);
  };

  const openAnnotationNode = (end: number) => {
    const container: RichText[] = [];
    pushNode({ type: "code", text: container });
    stack.push({ kind: "annotation", end });
    frameStack.push(container);
  };

  const openLinkNode = (href: string, end: number) => {
    const container: RichText[] = [];
    pushNode({ type: "url", text: container, url: href });
    stack.push({ kind: "link", href, end });
    frameStack.push(container);
  };

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? start;
    while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= start) {
      stack.pop();
      frameStack.pop();
    }

    const opening: Active[] = [];
    for (const span of annotationSpans) {
      if (span.start === start) {
        opening.push({ kind: "annotation", end: span.end });
      }
    }
    for (const link of links) {
      if (link.start !== start) {
        continue;
      }
      if (link.action.kind === "url") {
        opening.push({ kind: "link", href: link.action.href, end: link.end });
      } else {
        opening.push({ kind: "style", style: "code", end: link.end });
      }
    }
    for (const span of styleSpans) {
      if (span.start === start && isInlineStyle(span.style)) {
        opening.push({ kind: "style", style: span.style, end: span.end });
      }
    }
    opening.sort((left, right) => {
      if (left.end !== right.end) {
        return right.end - left.end;
      }
      const leftRank =
        left.kind === "style"
          ? (INLINE_STYLE_RANK[left.style] ?? 99)
          : left.kind === "link"
            ? 50
            : 0;
      const rightRank =
        right.kind === "style"
          ? (INLINE_STYLE_RANK[right.style] ?? 99)
          : right.kind === "link"
            ? 50
            : 0;
      return leftRank - rightRank;
    });

    const inCode =
      stack.some((entry) => entry.kind === "style" && entry.style === "code") ||
      stack.some((entry) => entry.kind === "annotation");

    for (const item of opening) {
      if (item.kind === "annotation") {
        openAnnotationNode(item.end);
      } else if (item.kind === "link") {
        if (!inCode && !stack.some((entry) => entry.kind === "link")) {
          openLinkNode(item.href, item.end);
        }
      } else if (!inCode || item.style === "code") {
        if (!(item.style === "code" && inCode)) {
          openStyleNode(item.style, item.end);
        }
      }
    }

    if (end > start) {
      // Unlike Bot API html mode, blocks preserve bare `\n` inside paragraph
      // RichText verbatim (live-verified 2026-07-15 via sendRichMessage echo).
      pushNode(text.slice(start, end));
    }
  }

  while (stack.length > 0) {
    stack.pop();
    frameStack.pop();
  }

  return normalizeRichText(root);
}

function pushParagraph(
  paragraphs: InputRichBlockParagraph[],
  ir: MarkdownIR,
  rangeStart: number,
  rangeEnd: number,
): void {
  // Trim the range (not the rendered text) so style/link offsets stay aligned;
  // gaps after structural blocks otherwise leak leading newlines into paragraphs.
  const raw = ir.text.slice(rangeStart, rangeEnd);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const absStart = rangeStart + leading;
  const absEnd = rangeEnd - trailing;
  if (absEnd <= absStart) {
    return;
  }
  paragraphs.push({ type: "paragraph", text: irRangeToRichText(ir, absStart, absEnd) });
}

function splitParagraphs(ir: MarkdownIR, start: number, end: number): InputRichBlockParagraph[] {
  if (end <= start) {
    return [];
  }
  const text = ir.text.slice(start, end);
  const paragraphs: InputRichBlockParagraph[] = [];
  const blankLine = /\n[ \t]*\n+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = blankLine.exec(text)) !== null) {
    pushParagraph(paragraphs, ir, start + last, start + match.index);
    last = match.index + match[0].length;
  }
  pushParagraph(paragraphs, ir, start + last, end);
  return paragraphs;
}

function renderAsciiTableGrid(table: MarkdownTableMeta): string {
  const rows = [table.headers, ...table.rows];
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: columnCount }, () => 3);
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index] ?? 3, row[index]?.length ?? 0);
    }
  }
  const renderRow = (row: readonly string[]) =>
    `| ${widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(table.headers), divider, ...table.rows.map(renderRow)].join("\n");
}

function cellToRichText(cell: MarkdownTableCell | undefined): RichText | undefined {
  if (!cell?.text) {
    return undefined;
  }
  const ir: MarkdownIR = {
    text: cell.text,
    styles: cell.styles,
    links: cell.links,
    ...(cell.annotations ? { annotations: cell.annotations } : {}),
  };
  const rich = irRangeToRichText(ir, 0, cell.text.length);
  return rich === "" ? undefined : rich;
}

function renderTableBlock(table: MarkdownTableMeta): {
  block: InputRichBlock;
  degradation?: TelegramRichBlocksDegradationReason;
} {
  const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
  if (columnCount > TELEGRAM_RICH_TEXT_TABLE_COLUMN_LIMIT) {
    return {
      block: { type: "pre", text: renderAsciiTableGrid(table) },
      degradation: "table-ascii",
    };
  }
  const headerRow: RichBlockTableCell[] = table.headerCells.map((cell, index) => {
    const align = table.aligns?.[index];
    const text = cellToRichText(cell);
    return {
      is_header: true,
      ...(text !== undefined ? { text } : {}),
      ...(align ? { align } : {}),
    };
  });
  const bodyRows: RichBlockTableCell[][] = table.rowCells.map((row) =>
    Array.from({ length: columnCount }, (_value, index) => {
      const align = table.aligns?.[index];
      const text = cellToRichText(row[index]);
      return {
        ...(text !== undefined ? { text } : {}),
        ...(align ? { align } : {}),
      };
    }),
  );
  const cells = headerRow.length > 0 ? [headerRow, ...bodyRows] : bodyRows;
  return {
    block: {
      type: "table",
      cells,
      is_bordered: true,
      is_striped: true,
    },
  };
}

function collectStructuralSegments(
  ir: MarkdownIR,
  tables: readonly MarkdownTableMeta[],
): StructuralSegment[] {
  const segments: StructuralSegment[] = [];
  for (const span of ir.styles) {
    if (span.end <= span.start) {
      continue;
    }
    const headingSize = resolveHeadingSize(span.style);
    if (headingSize) {
      segments.push({ kind: "heading", start: span.start, end: span.end, size: headingSize });
      continue;
    }
    if (span.style === "code_block") {
      segments.push({
        kind: "code_block",
        start: span.start,
        end: span.end,
        ...(span.language ? { language: span.language } : {}),
      });
      continue;
    }
    if (span.style === "blockquote") {
      segments.push({ kind: "blockquote", start: span.start, end: span.end });
    }
  }
  for (const table of tables) {
    const offset = Math.max(0, Math.min(table.placeholderOffset, ir.text.length));
    segments.push({ kind: "table", start: offset, end: offset, table });
  }
  // Containers sort before their children (start asc, end desc) so emitSegments
  // can consume contained segments recursively instead of double-emitting them.
  return segments.toSorted((left, right) => left.start - right.start || right.end - left.end);
}

function emitSegments(
  ir: MarkdownIR,
  segments: readonly StructuralSegment[],
  rangeStart: number,
  rangeEnd: number,
  degradationReasons: Set<TelegramRichBlocksDegradationReason>,
): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  let cursor = rangeStart;
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];
    if (!segment) {
      break;
    }
    if (segment.start > cursor) {
      blocks.push(...splitParagraphs(ir, cursor, segment.start));
    }
    // Segments nested inside this one (fences/headings/tables in a blockquote)
    // belong to it; consuming them here prevents a second top-level emission.
    let next = index + 1;
    while (next < segments.length && (segments[next]?.start ?? rangeEnd) < segment.end) {
      next += 1;
    }
    const children = segments.slice(index + 1, next);
    switch (segment.kind) {
      case "heading": {
        const text = irRangeToRichText(ir, segment.start, segment.end);
        if (text !== "") {
          blocks.push({ type: "heading", text, size: segment.size });
        }
        break;
      }
      case "code_block": {
        const text = ir.text.slice(segment.start, segment.end).replace(/\n$/, "");
        blocks.push({
          type: "pre",
          text,
          ...(segment.language ? { language: segment.language } : {}),
        });
        break;
      }
      case "blockquote": {
        const inner = emitSegments(ir, children, segment.start, segment.end, degradationReasons);
        if (inner.length > 0) {
          blocks.push({ type: "blockquote", blocks: inner });
        }
        break;
      }
      case "table": {
        const rendered = renderTableBlock(segment.table);
        if (rendered.degradation) {
          degradationReasons.add(rendered.degradation);
        }
        blocks.push(rendered.block);
        break;
      }
    }
    cursor = Math.max(cursor, segment.end);
    index = next;
  }
  if (cursor < rangeEnd) {
    blocks.push(...splitParagraphs(ir, cursor, rangeEnd));
  }
  return blocks;
}

export function countRichTextChars(text: RichText): number {
  if (typeof text === "string") {
    return text.length;
  }
  if (Array.isArray(text)) {
    return text.reduce((total, part) => total + countRichTextChars(part), 0);
  }
  return countRichTextChars(text.text);
}

export function countInputRichBlockChars(block: InputRichBlock): number {
  if (block.type === "paragraph" || block.type === "heading") {
    return countRichTextChars(block.text);
  }
  if (block.type === "pre") {
    return block.text.length;
  }
  if (block.type === "blockquote") {
    return block.blocks.reduce((total, item) => total + countInputRichBlockChars(item), 0);
  }
  return block.cells.reduce(
    (rowTotal, row) =>
      rowTotal +
      row.reduce((cellTotal, cell) => cellTotal + countRichTextChars(cell.text ?? ""), 0),
    0,
  );
}

export function markdownToTelegramRichBlocks(
  markdown: string,
  options: { tableMode?: MarkdownTableMode; skipEntityDetection?: boolean } = {},
): TelegramRichBlocksResult {
  const tableMode = options.tableMode ?? "block";
  // Parity scope: lists stay IR-flattened, media blocks out of scope (image alt
  // text only), and `---` keeps the IR's ─── text — the old rich path never
  // emitted <hr> for markdown either. Native list/media/divider blocks are a
  // follow-up contract.
  const { ir, tables } = markdownToIRWithMeta(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: options.skipEntityDetection !== true,
    enableSpoilers: true,
    headingStyle: "rich",
    blockquotePrefix: "",
    tableMode,
  });

  const degradationReasons = new Set<TelegramRichBlocksDegradationReason>();
  const segments = collectStructuralSegments(ir, tables);
  const blocks = emitSegments(ir, segments, 0, ir.text.length, degradationReasons);

  if (blocks.length === 0 && ir.text.trim()) {
    blocks.push({ type: "paragraph", text: ir.text });
  }

  return {
    blocks,
    // Tables are zero-width placeholders in ir.text; project the blocks so the
    // plain fallback keeps table content instead of silently dropping it.
    plainText: inputRichBlocksToPlainText(blocks),
    degradationReasons: [...degradationReasons],
  };
}

type RichTextWrapper = { type: InlineStyleKind } | { type: "url"; url: string };

function wrapRichTextFragment(fragment: RichText, wrappers: readonly RichTextWrapper[]): RichText {
  let node = fragment;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const wrapper = wrappers[index];
    if (!wrapper) {
      continue;
    }
    node =
      wrapper.type === "url"
        ? { type: "url", text: node, url: wrapper.url }
        : { type: wrapper.type, text: node };
  }
  return node;
}

// Split a RichText tree into pieces of at most `limit` plain chars, duplicating
// style/link wrappers across boundaries so link targets survive the split.
function splitRichTextByChars(text: RichText, limit: number): RichText[] {
  const pieces: RichText[] = [];
  let current: RichText[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) {
      pieces.push(normalizeRichText(current));
      current = [];
      chars = 0;
    }
  };
  const visit = (node: RichText, wrappers: readonly RichTextWrapper[]) => {
    if (typeof node === "string") {
      let offset = 0;
      while (offset < node.length) {
        if (chars >= limit) {
          flush();
        }
        const budget = limit - chars;
        const end = surrogateSafeChunkEnd(node, Math.min(node.length, offset + budget), offset);
        const fragment = node.slice(offset, end);
        current.push(wrapRichTextFragment(fragment, wrappers));
        chars += fragment.length;
        offset = end;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, wrappers);
      }
      return;
    }
    const wrapper: RichTextWrapper =
      node.type === "url" ? { type: "url", url: node.url } : { type: node.type };
    visit(node.text, [...wrappers, wrapper]);
  };
  visit(text, []);
  flush();
  return pieces;
}

function splitOversizedRichBlock(block: InputRichBlock, textLimit: number): InputRichBlock[] {
  if (countInputRichBlockChars(block) <= textLimit) {
    return [block];
  }
  if (block.type === "pre") {
    const language = block.language;
    return splitTelegramPlainTextChunks(block.text, textLimit).map((piece) =>
      language ? { type: "pre", text: piece, language } : { type: "pre", text: piece },
    );
  }
  if (block.type === "paragraph" || block.type === "heading") {
    return splitRichTextByChars(block.text, textLimit).map((piece) =>
      block.type === "heading"
        ? { type: "heading", text: piece, size: block.size }
        : { type: "paragraph", text: piece },
    );
  }
  if (block.type === "blockquote") {
    return splitTelegramRichBlocks(block.blocks, { textLimit }).map((inner) => ({
      type: "blockquote",
      blocks: inner,
    }));
  }
  const pieces: InputRichBlock[] = [];
  let rows: RichBlockTableCell[][] = [];
  let chars = 0;
  for (const row of block.cells) {
    const rowChars = row.reduce((total, cell) => total + countRichTextChars(cell.text ?? ""), 0);
    if (rows.length > 0 && chars + rowChars > textLimit) {
      pieces.push({ ...block, cells: rows });
      rows = [];
      chars = 0;
    }
    rows.push(row);
    chars += rowChars;
  }
  if (rows.length > 0) {
    pieces.push({ ...block, cells: rows });
  }
  return pieces;
}

export function splitTelegramRichBlocks(
  blocks: readonly InputRichBlock[],
  options: { blockLimit?: number; textLimit?: number } = {},
): InputRichBlock[][] {
  const blockLimit = Math.max(1, Math.floor(options.blockLimit ?? 500));
  const textLimit = Math.max(1, Math.floor(options.textLimit ?? 32_768));
  if (blocks.length === 0) {
    return [];
  }
  const expanded = blocks.flatMap((block) => splitOversizedRichBlock(block, textLimit));
  const chunks: InputRichBlock[][] = [];
  let current: InputRichBlock[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const block of expanded) {
    const chars = countInputRichBlockChars(block);
    const wouldExceedBlocks = current.length >= blockLimit;
    const wouldExceedChars = current.length > 0 && currentChars + chars > textLimit;
    if (wouldExceedBlocks || wouldExceedChars) {
      flush();
    }
    current.push(block);
    currentChars += chars;
  }
  flush();
  return chunks;
}

export function richTextToPlainString(text: RichText): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text.map(richTextToPlainString).join("");
  }
  return richTextToPlainString(text.text);
}

export function inputRichBlocksToPlainText(blocks: readonly InputRichBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
        parts.push(richTextToPlainString(block.text));
        break;
      case "pre":
        parts.push(block.text);
        break;
      case "blockquote":
        parts.push(inputRichBlocksToPlainText(block.blocks));
        break;
      case "table":
        for (const row of block.cells) {
          parts.push(row.map((cell) => richTextToPlainString(cell.text ?? "")).join(" | "));
        }
        break;
    }
  }
  return parts.join("\n");
}

export function boldRichText(text: string): RichText {
  return wrapStyle("bold", text);
}

export function codeRichText(text: string): RichText {
  return wrapStyle("code", text);
}

export function italicRichText(text: string): RichText {
  return wrapStyle("italic", text);
}

export function paragraphBlock(text: RichText): InputRichBlockParagraph {
  return { type: "paragraph", text };
}
