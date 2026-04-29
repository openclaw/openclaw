import type { FenceSpan } from "../markdown/fences.js";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "../markdown/fences.js";
import type { TableSpan } from "../markdown/table-spans.js";
import { findTableSpanAt, isSafeTableBreak, parseTableSpans } from "../markdown/table-spans.js";

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
  preserveNextWhitespace?: boolean;
};

type ParagraphBreak = {
  index: number;
  length: number;
};

function findSafeSentenceBreakIndex(
  text: string,
  fenceSpans: FenceSpan[],
  tableSpans: TableSpan[],
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
    if (isSafeMarkdownBreak(fenceSpans, tableSpans, offset + candidate)) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

function findSafeParagraphBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  tableSpans: TableSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, tableSpans, minChars, reverse, offset = 0 } = params;
  const re = /\n[\t ]*\n+/g;
  const matches = Array.from(text.matchAll(re));
  const ordered = reverse ? matches.toReversed() : matches;
  for (const match of ordered) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    const candidate = index + match[0].length;
    if (candidate < minChars) {
      continue;
    }
    if (candidate > text.length) {
      continue;
    }
    if (isSafeMarkdownBreak(fenceSpans, tableSpans, offset + candidate)) {
      return candidate;
    }
  }
  return -1;
}

function findSafeNewlineBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  tableSpans: TableSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, tableSpans, minChars, reverse, offset = 0 } = params;
  let newlineIdx = reverse ? text.lastIndexOf("\n") : text.indexOf("\n");
  while (reverse ? newlineIdx >= minChars : newlineIdx !== -1) {
    const candidate = newlineIdx + 1;
    if (candidate >= minChars && isSafeMarkdownBreak(fenceSpans, tableSpans, offset + candidate)) {
      return candidate;
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

function isSafeMarkdownBreak(
  fenceSpans: FenceSpan[],
  tableSpans: TableSpan[],
  index: number,
): boolean {
  return isSafeFenceBreak(fenceSpans, index) && isSafeTableBreak(tableSpans, index);
}

function extendBreakThroughParagraphSeparator(buffer: string, index: number): number {
  const paragraphSeparator = buffer.slice(index).match(/^\n[\t ]*\n+/);
  return paragraphSeparator ? index + paragraphSeparator[0].length : index;
}

function findTableRowBreakBeforeLimit(params: {
  buffer: string;
  table: TableSpan;
  offset: number;
  minChars: number;
  maxChars: number;
}): number {
  const { buffer, table, offset, minChars, maxChars } = params;
  const tableStart = Math.max(0, table.start - offset);
  const tableEnd = Math.min(buffer.length, table.end - offset);
  const limit = Math.min(maxChars, tableEnd);
  let newlineIdx = buffer.lastIndexOf("\n", limit - 1);
  while (newlineIdx >= tableStart) {
    const candidate = newlineIdx + 1;
    if (candidate > tableStart && candidate >= minChars && candidate <= maxChars) {
      return candidate;
    }
    newlineIdx = buffer.lastIndexOf("\n", newlineIdx - 1);
  }
  return -1;
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
    // KNOWN: We cannot split inside fenced code blocks (Markdown breaks + UI glitches).
    // When forced (maxChars), we close + reopen the fence to keep Markdown valid.
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
    const tableSpans = parseTableSpans(source);
    let start = 0;
    let reopenFence: FenceSpan | undefined;

    while (start < source.length) {
      const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : "";
      const remainingLength = reopenPrefix.length + (source.length - start);

      if (!force && remainingLength < minChars) {
        break;
      }

      if (this.#chunking.flushOnParagraph && !force) {
        const paragraphBreak = findNextParagraphBreak(
          source,
          fenceSpans,
          tableSpans,
          start,
          minChars,
        );
        const paragraphLimit = Math.max(1, maxChars - reopenPrefix.length);
        if (paragraphBreak && paragraphBreak.index - start <= paragraphLimit) {
          const chunk = `${reopenPrefix}${source.slice(
            start,
            paragraphBreak.index + paragraphBreak.length,
          )}`;
          if (chunk.trim().length > 0) {
            emit(chunk);
          }
          start = paragraphBreak.index + paragraphBreak.length;
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
          ? this.#pickSoftBreakIndex(view, fenceSpans, tableSpans, 1, start)
          : this.#pickBreakIndex(view, fenceSpans, tableSpans, force ? 1 : undefined, start);
      if (breakResult.index <= 0) {
        if (force) {
          emit(`${reopenPrefix}${source.slice(start)}`);
          start = source.length;
          reopenFence = undefined;
        }
        break;
      }

      const consumed = this.#emitBreakResult({
        breakResult,
        emit,
        reopenPrefix,
        source,
        start,
      });
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
      !breakResult.preserveNextWhitespace &&
      absoluteBreakIdx < source.length &&
      /\s/.test(source[absoluteBreakIdx])
        ? absoluteBreakIdx + 1
        : absoluteBreakIdx;
    return {
      start: breakResult.preserveNextWhitespace
        ? nextStart
        : skipLeadingNewlines(source, nextStart),
      reopenFence: undefined,
    };
  }

  #pickSoftBreakIndex(
    buffer: string,
    fenceSpans: FenceSpan[],
    tableSpans: TableSpan[],
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
        fenceSpans,
        tableSpans,
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
        fenceSpans,
        tableSpans,
        minChars,
        reverse: false,
        offset,
      });
      if (newlineIdx !== -1) {
        return { index: newlineIdx };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(
        buffer,
        fenceSpans,
        tableSpans,
        minChars,
        offset,
      );
      if (sentenceIdx !== -1) {
        return { index: sentenceIdx };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(
    buffer: string,
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
        fenceSpans,
        tableSpans,
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
        fenceSpans,
        tableSpans,
        minChars,
        reverse: true,
        offset,
      });
      if (newlineIdx !== -1) {
        return { index: newlineIdx };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(
        window,
        fenceSpans,
        tableSpans,
        minChars,
        offset,
      );
      if (sentenceIdx !== -1) {
        return { index: sentenceIdx };
      }
    }

    if (preference === "newline" && buffer.length < maxChars) {
      return { index: -1 };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeMarkdownBreak(fenceSpans, tableSpans, offset + i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeMarkdownBreak(fenceSpans, tableSpans, offset + maxChars)) {
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
      const table = findTableSpanAt(tableSpans, offset + maxChars);
      if (table) {
        const tableStart = table.start - offset;
        if (tableStart >= minChars) {
          return { index: tableStart };
        }
        const tableEnd = table.end - offset;
        if (tableEnd > 0 && tableEnd <= buffer.length) {
          const extendedTableEnd = extendBreakThroughParagraphSeparator(buffer, tableEnd);
          if (extendedTableEnd <= maxChars) {
            return { index: extendedTableEnd };
          }
        }
        const rowBreak = findTableRowBreakBeforeLimit({
          buffer,
          table,
          offset,
          minChars,
          maxChars,
        });
        if (rowBreak !== -1) {
          return { index: rowBreak, preserveNextWhitespace: true };
        }
        return { index: maxChars, preserveNextWhitespace: true };
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
  fenceSpans: FenceSpan[],
  tableSpans: TableSpan[],
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
    if (!isSafeMarkdownBreak(fenceSpans, tableSpans, index)) {
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
