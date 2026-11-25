import { isSafeFenceBreak, type FenceSpan } from "../../packages/markdown-core/src/fences.js";
import type { BreakSpan, BreakSpans } from "./embedded-agent-block-chunker.tables.js";

// Block-level HTML islands that channel renderers (for example Telegram rich
// messages) only parse when the opening and closing tags arrive in one message.
const HTML_BLOCK_TAG_RE =
  /<(\/?)(details|table|ul|ol|dl|aside|blockquote|figure|tg-collage|tg-slideshow)(?=[\s/>])[^<>]*>/gi;

function isInsideInlineCode(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  let ticks = 0;
  for (let i = lineStart; i < index; i += 1) {
    if (source.charCodeAt(i) === 96 /* ` */) {
      ticks += 1;
    }
  }
  return ticks % 2 === 1;
}

/**
 * Keep fitting block-level HTML islands (`<details>`, `<ul>`, `<table>`, ...)
 * whole, so a chunk boundary never lands between an opening tag and its
 * closer. Islands longer than `maxChars` keep the ordinary hard-split
 * fallback. While streaming, a still-open island holds back breaks until it
 * closes or outgrows `maxChars`.
 */
export function findHtmlBlockSpans(
  source: string,
  fenceSpans: FenceSpan[],
  maxChars: number,
  streaming: boolean,
): BreakSpan[] {
  if (!source.includes("<")) {
    return [];
  }
  const spans: BreakSpan[] = [];
  const stack: string[] = [];
  let openStart = -1;
  HTML_BLOCK_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_BLOCK_TAG_RE.exec(source)) !== null) {
    const index = match.index;
    if (!isSafeFenceBreak(fenceSpans, index) || isInsideInlineCode(source, index)) {
      continue;
    }
    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const selfClosing = !closing && /\/\s*>$/.test(match[0]);
    if (selfClosing) {
      continue;
    }
    if (!closing) {
      if (stack.length === 0) {
        openStart = index;
      }
      stack.push(name);
      continue;
    }
    const openIndex = stack.lastIndexOf(name);
    if (openIndex < 0) {
      continue;
    }
    stack.length = openIndex;
    if (stack.length === 0 && openStart >= 0) {
      const end = index + match[0].length;
      if (end - openStart <= maxChars) {
        spans.push({ start: openStart, end });
      }
      openStart = -1;
    }
  }
  if (streaming && stack.length > 0 && openStart >= 0 && source.length - openStart <= maxChars) {
    spans.push({ start: openStart, end: source.length });
  }
  return spans;
}

/**
 * When the hard cut would land inside a fitting island, break before the
 * island instead, even below minChars, so the island travels in one chunk.
 */
export function findHtmlBlockBreakIndex(
  buffer: string,
  offset: number,
  windowLength: number,
  spans: BreakSpans,
): number | undefined {
  const cut = offset + windowLength;
  const block = spans.htmlBlocks?.find((span) => span.start < cut && cut < span.end);
  if (!block || block.start <= offset) {
    return undefined;
  }
  const htmlBreak = buffer.slice(0, block.start - offset).trimEnd().length;
  return htmlBreak > 0 && isSafeFenceBreak(spans.unsafe, offset + htmlBreak)
    ? htmlBreak
    : undefined;
}

/** Sort and merge overlapping spans so binary-search lookups stay valid. */
export function mergeBreakSpans(spans: readonly BreakSpan[]): BreakSpan[] {
  const sorted = spans.toSorted((left, right) => left.start - right.start);
  const merged: BreakSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}
