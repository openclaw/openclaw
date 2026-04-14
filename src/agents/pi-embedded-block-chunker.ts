import type { FenceSpan } from "../markdown/fences.js";
import { findFenceSpanAt, parseFenceSpans } from "../markdown/fences.js";
import { parseTableSpans } from "../markdown/table-spans.js";
import type { TableSpan } from "../markdown/table-spans.js";

type ProtectedSpan = { start: number; end: number };

export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
  /** When true, prefer \n\n paragraph boundaries once minChars has been satisfied. */
  flushOnParagraph?: boolean;
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
  fence: FenceSpan;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

type ParagraphBreak = {
  index: number;
  length: number;
};

function isInsideAnySpan(spans: ProtectedSpan[], index: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) {
      break;
    }
    if (index <= span.start) {
      high = mid - 1;
    } else if (index >= span.end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

function isSafeBreak(spans: ProtectedSpan[], index: number): boolean {
  return !isInsideAnySpan(spans, index);
}

function findSafeSentenceBreakIndex(
  text: string,
  protectedSpans: ProtectedSpan[],
  minChars: number,
  offset = 0,
): number {
  const matches = text.matchAll(/[.!?](?=\s|$)/g);
  let sentenceIdx = -1;
  for (const match of matches) {
    const at = match.index ?? -1;
    if (at < minChars) {
      continue;
    }
    const candidate = at + 1;
    if (isSafeBreak(protectedSpans, offset + candidate)) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

function findSafeParagraphBreakIndex(params: {
  text: string;
  protectedSpans: ProtectedSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, protectedSpans, minChars, reverse, offset = 0 } = params;
  let paragraphIdx = reverse ? text.lastIndexOf("\n\n") : text.indexOf("\n\n");
  while (reverse ? paragraphIdx >= minChars : paragraphIdx !== -1) {
    const candidates = [paragraphIdx, paragraphIdx + 1];
    for (const candidate of candidates) {
      if (candidate < minChars) {
        continue;
      }
      if (candidate < 0 || candidate >= text.length) {
        continue;
      }
      if (isSafeBreak(protectedSpans, offset + candidate)) {
        return candidate;
      }
    }
    paragraphIdx = reverse
      ? text.lastIndexOf("\n\n", paragraphIdx - 1)
      : text.indexOf("\n\n", paragraphIdx + 2);
  }
  return -1;
}

function findSafeNewlineBreakIndex(params: {
  text: string;
  protectedSpans: ProtectedSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, protectedSpans, minChars, reverse, offset = 0 } = params;
  let newlineIdx = reverse ? text.lastIndexOf("\n") : text.indexOf("\n");
  while (reverse ? newlineIdx >= minChars : newlineIdx !== -1) {
    if (newlineIdx >= minChars && isSafeBreak(protectedSpans, offset + newlineIdx)) {
      return newlineIdx;
    }
    newlineIdx = reverse
      ? text.lastIndexOf("\n", newlineIdx - 1)
      : text.indexOf("\n", newlineIdx + 1);
  }
  return -1;
}

function findFenceCloseLineStart(buffer: string, fence: FenceSpan, offset = 0): number {
  const relativeFenceEnd = Math.min(buffer.length, Math.max(0, fence.end - offset));
  if (relativeFenceEnd <= 0) {
    return -1;
  }
  const lastNewline = buffer.lastIndexOf("\n", relativeFenceEnd - 1);
  return lastNewline >= 0 ? lastNewline + 1 : -1;
}

function findSpanAt(spans: ProtectedSpan[], index: number): ProtectedSpan | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) {
      break;
    }
    if (index <= span.start) {
      high = mid - 1;
    } else if (index >= span.end) {
      low = mid + 1;
    } else {
      return span;
    }
  }
  return undefined;
}

export class EmbeddedBlockChunker {
  #buffer = "";
  readonly #chunking: BlockReplyChunking;

  constructor(chunking: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  append(text: string) {
    if (!text) {
      return;
    }
    this.#buffer += text;
  }

  reset() {
    this.#buffer = "";
  }

  get bufferedText() {
    return this.#buffer;
  }

  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

  drain(params: { force: boolean; emit: (chunk: string) => void }) {
    const { force, emit } = params;
    const minChars = Math.max(1, Math.floor(this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));

    if (this.#buffer.length < minChars && !force) {
      return;
    }

    if (force && this.#buffer.length <= maxChars) {
      if (this.#buffer.trim().length > 0) {
        emit(this.#buffer);
      }
      this.#buffer = "";
      return;
    }

    const source = this.#buffer;
    const fenceSpans = parseFenceSpans(source);
    const tableSpans = parseTableSpans(source, fenceSpans);
    const protectedSpans: ProtectedSpan[] = [...fenceSpans, ...tableSpans].toSorted(
      (a, b) => a.start - b.start,
    );
    let start = 0;
    let reopenFence: FenceSpan | undefined;

    while (start < source.length) {
      const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : "";
      const remainingLength = reopenPrefix.length + (source.length - start);

      if (!force && remainingLength < minChars) {
        break;
      }

      if (this.#chunking.flushOnParagraph && !force) {
        const paragraphBreak = findNextParagraphBreak(source, protectedSpans, start, minChars);
        const paragraphLimit = Math.max(1, maxChars - reopenPrefix.length);
        if (paragraphBreak && paragraphBreak.index - start <= paragraphLimit) {
          const chunk = `${reopenPrefix}${source.slice(start, paragraphBreak.index)}`;
          if (chunk.trim().length > 0) {
            emit(chunk);
          }
          start = skipLeadingNewlines(source, paragraphBreak.index + paragraphBreak.length);
          reopenFence = undefined;
          continue;
        }
        if (remainingLength < maxChars) {
          break;
        }
      }

      const view = source.slice(start);
      const breakResult =
        force && remainingLength <= maxChars
          ? this.#pickSoftBreakIndex(view, protectedSpans, 1, start)
          : this.#pickBreakIndex(
              view,
              protectedSpans,
              fenceSpans,
              tableSpans,
              force ? 1 : undefined,
              start,
            );
      if (breakResult.index <= 0) {
        if (force) {
          emit(`${reopenPrefix}${source.slice(start)}`);
          start = source.length;
          reopenFence = undefined;
        }
        break;
      }

      const consumed = this.#emitBreakResult({ breakResult, emit, reopenPrefix, source, start });
      if (consumed === null) {
        continue;
      }
      start = consumed.start;
      reopenFence = consumed.reopenFence;

      const nextLength =
        (reopenFence ? `${reopenFence.openLine}\n`.length : 0) + (source.length - start);
      if (nextLength < minChars && !force) {
        break;
      }
      if (nextLength < maxChars && !force && !this.#chunking.flushOnParagraph) {
        break;
      }
    }
    this.#buffer = reopenFence
      ? `${reopenFence.openLine}\n${source.slice(start)}`
      : stripLeadingNewlines(source.slice(start));
  }

  #emitBreakResult(params: {
    breakResult: BreakResult;
    emit: (chunk: string) => void;
    reopenPrefix: string;
    source: string;
    start: number;
  }): { start: number; reopenFence?: FenceSpan } | null {
    const { breakResult, emit, reopenPrefix, source, start } = params;
    const breakIdx = breakResult.index;
    if (breakIdx <= 0) {
      return null;
    }

    const absoluteBreakIdx = start + breakIdx;
    let rawChunk = `${reopenPrefix}${source.slice(start, absoluteBreakIdx)}`;
    if (rawChunk.trim().length === 0) {
      return { start: skipLeadingNewlines(source, absoluteBreakIdx), reopenFence: undefined };
    }

    const fenceSplit = breakResult.fenceSplit;
    if (fenceSplit) {
      const closeFence = rawChunk.endsWith("\n")
        ? `${fenceSplit.closeFenceLine}\n`
        : `\n${fenceSplit.closeFenceLine}\n`;
      rawChunk = `${rawChunk}${closeFence}`;
    }

    emit(rawChunk);

    if (fenceSplit) {
      return { start: absoluteBreakIdx, reopenFence: fenceSplit.fence };
    }

    const nextStart =
      absoluteBreakIdx < source.length && /\s/.test(source[absoluteBreakIdx])
        ? absoluteBreakIdx + 1
        : absoluteBreakIdx;
    return { start: skipLeadingNewlines(source, nextStart), reopenFence: undefined };
  }

  #pickSoftBreakIndex(
    buffer: string,
    protectedSpans: ProtectedSpan[],
    minCharsOverride?: number,
    offset = 0,
  ): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      const paragraphIdx = findSafeParagraphBreakIndex({
        text: buffer,
        protectedSpans,
        minChars,
        reverse: false,
        offset,
      });
      if (paragraphIdx !== -1) {
        return { index: paragraphIdx };
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      const newlineIdx = findSafeNewlineBreakIndex({
        text: buffer,
        protectedSpans,
        minChars,
        reverse: false,
        offset,
      });
      if (newlineIdx !== -1) {
        return { index: newlineIdx };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(buffer, protectedSpans, minChars, offset);
      if (sentenceIdx !== -1) {
        return { index: sentenceIdx };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(
    buffer: string,
    protectedSpans: ProtectedSpan[],
    fenceSpans: FenceSpan[],
    tableSpans: TableSpan[],
    minCharsOverride?: number,
    offset = 0,
  ): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));

    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      const paragraphIdx = findSafeParagraphBreakIndex({
        text: window,
        protectedSpans,
        minChars,
        reverse: true,
        offset,
      });
      if (paragraphIdx !== -1) {
        return { index: paragraphIdx };
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      const newlineIdx = findSafeNewlineBreakIndex({
        text: window,
        protectedSpans,
        minChars,
        reverse: true,
        offset,
      });
      if (newlineIdx !== -1) {
        return { index: newlineIdx };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(window, protectedSpans, minChars, offset);
      if (sentenceIdx !== -1) {
        return { index: sentenceIdx };
      }
    }

    if (preference === "newline" && buffer.length < maxChars) {
      return { index: -1 };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeBreak(protectedSpans, offset + i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeBreak(protectedSpans, offset + maxChars)) {
        return { index: maxChars };
      }

      const fence = findFenceSpanAt(fenceSpans, offset + maxChars);
      if (fence) {
        const closeFenceStart = findFenceCloseLineStart(buffer, fence, offset);
        if (closeFenceStart >= minChars && closeFenceStart < maxChars) {
          return {
            index: closeFenceStart,
            fenceSplit: {
              closeFenceLine: `${fence.indent}${fence.marker}`,
              reopenFenceLine: fence.openLine,
              fence,
            },
          };
        }
        return {
          index: maxChars,
          fenceSplit: {
            closeFenceLine: `${fence.indent}${fence.marker}`,
            reopenFenceLine: fence.openLine,
            fence,
          },
        };
      }

      const table = findSpanAt(tableSpans, offset + maxChars);
      if (table) {
        const relativeTableEnd = table.end - offset;
        if (relativeTableEnd <= buffer.length && relativeTableEnd < maxChars * 2) {
          return { index: Math.min(relativeTableEnd, buffer.length) };
        }
      }

      return { index: maxChars };
    }

    return { index: -1 };
  }
}

function skipLeadingNewlines(value: string, start = 0): number {
  let i = start;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i;
}

function stripLeadingNewlines(value: string): string {
  const start = skipLeadingNewlines(value);
  return start > 0 ? value.slice(start) : value;
}

function findNextParagraphBreak(
  buffer: string,
  protectedSpans: ProtectedSpan[],
  startIndex = 0,
  minCharsFromStart = 1,
): ParagraphBreak | null {
  if (startIndex < 0) {
    return null;
  }
  const re = /\n[\t ]*\n+/g;
  re.lastIndex = startIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    if (index - startIndex < minCharsFromStart) {
      continue;
    }
    if (!isSafeBreak(protectedSpans, index)) {
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
