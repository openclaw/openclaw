/**
 * Splits streamed embedded-agent replies into Markdown-safe message chunks.
 */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { FenceSpan } from "../../packages/markdown-core/src/fences.js";
import {
  findFenceSpanAt,
  isSafeFenceBreak,
  scanFenceSpans,
} from "../../packages/markdown-core/src/fences.js";
import { prepareIndentedCode } from "./embedded-agent-block-chunker.code.js";
import {
  findTableBreakIndex,
  findUnsplittableTableSpans,
  type BreakSpan,
  type BreakSpans,
} from "./embedded-agent-block-chunker.tables.js";

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

export type BlockChunkMetadata = {
  sourceText: string;
  sourceGeneration: number;
  reconciledSourceBreak?: true;
  sourceStart: number;
  sourceEnd: number;
  startsAtLineStart: boolean;
};

type BlockChunkDrain = {
  force: boolean;
  emit: (chunk: string, options?: BlockChunkMetadata) => void;
};

function findSafeSentenceBreakIndex(
  text: string,
  unsafeSpans: readonly BreakSpan[],
  minChars: number,
  offset = 0,
  openFence?: FenceSpan,
): number {
  const matches = text.matchAll(/[.!?](?=\s|$)/g);
  let sentenceIdx = -1;
  for (const match of matches) {
    const at = match.index;
    if (at < minChars) {
      continue;
    }
    const candidate = at + 1;
    if (
      offset + candidate !== openFence?.end &&
      isSafeFenceBreak(unsafeSpans, offset + candidate)
    ) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

function findSafeLineBreakIndex(params: {
  text: string;
  unsafeSpans: readonly BreakSpan[];
  minChars: number;
  reverse: boolean;
  separator: "\n" | "\n\n";
  offset?: number;
}): number {
  const { text, unsafeSpans, minChars, reverse, separator, offset = 0 } = params;
  let index = reverse ? text.lastIndexOf(separator) : text.indexOf(separator);
  while (reverse ? index >= minChars : index !== -1) {
    for (let candidate = index; candidate < index + separator.length; candidate++) {
      if (candidate >= minChars && isSafeFenceBreak(unsafeSpans, offset + candidate)) {
        return candidate;
      }
    }
    index = reverse
      ? text.lastIndexOf(separator, index - 1)
      : text.indexOf(separator, index + separator.length);
  }
  return -1;
}

function findFenceCloseLineStart(buffer: string, fence: FenceSpan, offset = 0): number {
  const relativeFenceEnd = Math.min(buffer.length, Math.max(0, fence.end - offset));
  if (relativeFenceEnd <= 0) {
    return -1;
  }
  const lastNewline = buffer.lastIndexOf("\n", relativeFenceEnd - 1);
  if (lastNewline < 0) {
    return -1;
  }
  // Open spans also end at the buffer boundary; consuming their final content
  // line as a closing marker would silently drop streamed code.
  const closingMarker = buffer
    .slice(lastNewline + 1, relativeFenceEnd)
    .match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/)?.[1];
  return closingMarker &&
    closingMarker.charAt(0) === fence.marker.charAt(0) &&
    closingMarker.length >= fence.marker.length
    ? lastNewline + 1
    : -1;
}

function resolveFenceReopenLine(fence: FenceSpan, maxChars: number): string | undefined {
  const bareMarker = `${fence.indent}${fence.marker}`;
  if (bareMarker.length * 2 + 3 > maxChars) {
    return undefined;
  }
  return fence.openLine.length + bareMarker.length + 3 <= maxChars ? fence.openLine : bareMarker;
}

export class EmbeddedBlockChunker {
  #buffer = "";
  #reopenPrefix = "";
  #consumedLength = 0;
  #preparedSourceBreaks: number[] = [];
  #sourceBreaks: readonly number[] = [];
  #sourceGeneration = 0;
  #sourceOffset = 0;
  #nextSourceBreak = 0;
  #bufferStartsAtLineStart = true;
  #codeContext = "";
  readonly #chunking?: BlockReplyChunking;

  constructor(chunking?: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  append(text: string) {
    if (!text) {
      return;
    }
    this.#buffer += text;
  }

  /** Start a new source scope without emitting pending text. */
  reset(sourceBreaks: readonly number[] = [], sourceOffset = 0) {
    this.#buffer = "";
    this.#reopenPrefix = "";
    this.#consumedLength = 0;
    this.#preparedSourceBreaks = [];
    this.#sourceBreaks = sourceBreaks;
    this.#sourceGeneration += 1;
    this.#sourceOffset = sourceOffset;
    this.#nextSourceBreak = 0;
    this.#bufferStartsAtLineStart = true;
    this.#codeContext = "";
  }

  /** UTF-16 source positions exclude synthetic fences and include skipped whitespace. */
  get consumedLength() {
    return this.#consumedLength;
  }

  /** Prepared source boundaries are not evidence that a recipient received a chunk. */
  get preparedSourceBreaks(): readonly number[] {
    return this.#preparedSourceBreaks;
  }

  get sourceLength() {
    return this.#consumedLength + this.#buffer.length;
  }

  /** Replace pending source; the snapshot owner can attest that the consumed prefix is unchanged. */
  replace(text: string, sourceOffset = 0, prefixRetained = false): boolean {
    const pendingOffset = sourceOffset - this.#consumedLength;
    const next =
      this.#buffer.slice(0, Math.max(0, pendingOffset)) + text.slice(Math.max(0, -pendingOffset));
    const changed = next !== this.#buffer;
    if (!next.startsWith(this.#buffer) || sourceOffset + text.length < this.#consumedLength) {
      this.#sourceBreaks = [];
      this.#nextSourceBreak = 0;
    }
    this.#buffer = next;
    if (sourceOffset === 0 && text.length < this.#consumedLength) {
      const { spans, state } = scanFenceSpans(text);
      const fence = state.open ? spans.at(-1) : undefined;
      const maxChars = Math.max(
        1,
        Math.floor(this.#chunking?.minChars ?? 1),
        Math.floor(this.#chunking?.maxChars ?? Infinity),
      );
      const reopenLine =
        fence && this.#chunking ? resolveFenceReopenLine(fence, maxChars) : undefined;
      this.#reopenPrefix = reopenLine ? `${reopenLine}\n` : "";
      this.#codeContext = prepareIndentedCode(text, "", true, maxChars).contextAt(text.length);
    }
    const consumedLength = Math.min(this.#consumedLength, sourceOffset + text.length);
    if (!prefixRetained && sourceOffset === 0 && this.#codeContext && consumedLength > 0) {
      const maxChars = Math.max(
        1,
        Math.floor(this.#chunking?.minChars ?? 1),
        Math.floor(this.#chunking?.maxChars ?? Infinity),
      );
      this.#codeContext = prepareIndentedCode(text, "", true, maxChars).contextAt(consumedLength);
    }
    if (consumedLength === 0) {
      this.#bufferStartsAtLineStart = true;
      this.#codeContext = "";
    } else if (consumedLength > sourceOffset) {
      this.#bufferStartsAtLineStart = text.charAt(consumedLength - sourceOffset - 1) === "\n";
    } else if (consumedLength < this.#consumedLength) {
      // A withdrawn, already-delivered prefix cannot establish a new fence boundary.
      this.#bufferStartsAtLineStart = false;
    }
    this.#consumedLength = consumedLength;
    while ((this.#preparedSourceBreaks.at(-1) ?? 0) > this.#consumedLength) {
      this.#preparedSourceBreaks.pop();
    }
    return changed;
  }

  get bufferedText() {
    return this.#buffer ? `${this.#reopenPrefix}${this.#buffer}` : "";
  }

  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

  /** Emit safe chunks according to size and Markdown fence constraints. */
  drain(params: BlockChunkDrain) {
    const sourceBreaks = this.#sourceBreaks;
    while (this.#nextSourceBreak < sourceBreaks.length) {
      const length = sourceBreaks[this.#nextSourceBreak]! - this.#consumedLength;
      if (length <= 0) {
        this.#nextSourceBreak += 1;
        continue;
      }
      if (length > this.#buffer.length) {
        break;
      }
      const availableLength = this.bufferedText.length;
      const tail = this.#buffer.slice(length);
      this.#buffer = this.#buffer.slice(0, length);
      this.#drainBuffer(params, availableLength, true);
      if (this.#sourceBreaks !== sourceBreaks) {
        return;
      }
      const reachedBreak = this.#buffer.length === 0;
      this.#buffer += tail;
      if (!reachedBreak) {
        return;
      }
      this.#nextSourceBreak += 1;
    }
    this.#drainBuffer(params);
  }

  #drainBuffer(params: BlockChunkDrain, availableLength = 0, reconciledSourceBreak = false) {
    // KNOWN: We cannot split inside fenced code blocks (Markdown breaks + UI glitches).
    // When forced (maxChars), we close + reopen the fence to keep Markdown valid.
    const { emit } = params;
    const sourceStart = this.#consumedLength;
    const preparedSourceBreaks = this.#preparedSourceBreaks;
    const chunking = this.#chunking;
    if (!this.#buffer || (!params.force && !chunking)) {
      return;
    }
    if (!chunking) {
      preparedSourceBreaks.push(sourceStart + this.#buffer.length);
      emit(this.bufferedText, {
        sourceText: this.#buffer,
        sourceGeneration: this.#sourceGeneration,
        reconciledSourceBreak: reconciledSourceBreak || undefined,
        sourceStart: this.#sourceOffset + this.#consumedLength,
        sourceEnd: this.#sourceOffset + this.#consumedLength + this.#buffer.length,
        startsAtLineStart: Boolean(this.#reopenPrefix) || this.#bufferStartsAtLineStart,
      });
      this.#bufferStartsAtLineStart = this.#buffer.endsWith("\n");
      this.#consumedLength += this.#buffer.length;
      this.#buffer = "";
      this.#reopenPrefix = "";
      this.#codeContext = "";
      return;
    }
    const minChars = Math.max(1, Math.floor(chunking.minChars ?? 1));
    const maxChars = Math.max(minChars, Math.floor(chunking.maxChars ?? Infinity));
    const force = params.force || availableLength >= maxChars;
    const originalSource = this.bufferedText;
    if (originalSource.length < minChars && !force) {
      return;
    }
    const indentedCode = prepareIndentedCode(originalSource, this.#codeContext, force, maxChars);
    let source = indentedCode.text;
    const startsAtLineStart =
      Boolean(this.#reopenPrefix) || indentedCode.startsWithCode || this.#bufferStartsAtLineStart;

    if (source.length < minChars && !force) {
      return;
    }

    if (force && source.length <= maxChars && !this.#reopenPrefix) {
      if (source.trim().length > 0) {
        preparedSourceBreaks.push(sourceStart + this.#buffer.length);
        emit(source, {
          sourceText: this.#buffer,
          sourceGeneration: this.#sourceGeneration,
          reconciledSourceBreak: reconciledSourceBreak || undefined,
          sourceStart: this.#sourceOffset + this.#consumedLength,
          sourceEnd: this.#sourceOffset + this.#consumedLength + this.#buffer.length,
          startsAtLineStart,
        });
      }
      this.#bufferStartsAtLineStart = this.#buffer.endsWith("\n");
      this.#codeContext = indentedCode.contextAt(originalSource.length);
      this.#consumedLength += this.#buffer.length;
      this.#buffer = "";
      this.#reopenPrefix = "";
      return;
    }

    // Keep original source text so shortened language hints and synthetic
    // fences cannot move the source cursor during checkpoint reconciliation.
    const { spans: fenceSpans, state: fenceState } = scanFenceSpans(source, {
      atLineStart: startsAtLineStart,
    });
    const openFence = fenceState.open ? fenceSpans.at(-1) : undefined;
    const removedFenceInfo: Array<{ at: number; length: number }> = [];
    let removedFenceInfoLength = 0;
    for (const fence of fenceSpans) {
      fence.start -= removedFenceInfoLength;
      fence.end -= removedFenceInfoLength;
      const reopenFenceLine = resolveFenceReopenLine(fence, maxChars);
      if (
        !reopenFenceLine ||
        reopenFenceLine === fence.openLine ||
        fence.end - fence.start <= maxChars
      ) {
        continue;
      }
      // A language hint that cannot fit with its balanced fence must degrade
      // as metadata; splitting the hint would leak it into visible code.
      source =
        source.slice(0, fence.start) +
        reopenFenceLine +
        source.slice(fence.start + fence.openLine.length);
      const removedLength = fence.openLine.length - reopenFenceLine.length;
      removedFenceInfo.push({ at: fence.start + reopenFenceLine.length, length: removedLength });
      fence.openLine = reopenFenceLine;
      fence.end -= removedLength;
      removedFenceInfoLength += removedLength;
    }
    const tables = findUnsplittableTableSpans(source, fenceSpans, maxChars, !force);
    const unsafe =
      tables.length > 0
        ? [...fenceSpans, ...tables].toSorted((left, right) => left.start - right.start)
        : fenceSpans;
    const spans: BreakSpans = { fences: fenceSpans, tables, unsafe };
    const originalIndex = (index: number) =>
      removedFenceInfo.reduce(
        (offset, removed) => offset + (removed.at <= index ? removed.length : 0),
        index,
      );
    const sourceOffset = (index: number) =>
      Math.max(0, indentedCode.toSource(originalIndex(index)) - this.#reopenPrefix.length);
    let start = 0;
    let reopenFence: FenceSplit | undefined;
    const emitSourceChunk = (chunk: string, from: number, to: number) => {
      preparedSourceBreaks.push(sourceStart + sourceOffset(to));
      emit(chunk, {
        sourceText: this.#buffer.slice(sourceOffset(from), sourceOffset(to)),
        sourceGeneration: this.#sourceGeneration,
        reconciledSourceBreak: reconciledSourceBreak || undefined,
        sourceStart: this.#sourceOffset + this.#consumedLength + sourceOffset(from),
        sourceEnd: this.#sourceOffset + this.#consumedLength + sourceOffset(to),
        startsAtLineStart:
          Boolean(reopenFence) ||
          (from === 0 ? startsAtLineStart : source.charAt(from - 1) === "\n"),
      });
    };
    const resumedFence = this.#reopenPrefix ? fenceSpans[0] : undefined;
    if (resumedFence) {
      const closeStart = findFenceCloseLineStart(source, resumedFence);
      if (
        closeStart >= this.#reopenPrefix.length &&
        !source.slice(this.#reopenPrefix.length, closeStart).trim()
      ) {
        // A checkpoint can withdraw the remaining body while retaining its
        // source closer. Earlier chunks already carried a synthetic closer.
        start = skipLeadingNewlines(source, resumedFence.end);
      }
    }

    while (start < source.length) {
      const reopenPrefix = reopenFence ? `${reopenFence.reopenFenceLine}\n` : "";
      const remainingLength = reopenPrefix.length + (source.length - start);

      if (!force && remainingLength < minChars) {
        break;
      }

      if (chunking.flushOnParagraph && !force) {
        const paragraphBreak = findNextParagraphBreak(source, fenceSpans, start, minChars);
        const paragraphLimit = Math.max(1, maxChars - reopenPrefix.length);
        if (paragraphBreak && paragraphBreak.index - start <= paragraphLimit) {
          const chunk = `${reopenPrefix}${source.slice(start, paragraphBreak.index)}`;
          const nextStart = skipLeadingNewlines(
            source,
            paragraphBreak.index + paragraphBreak.length,
          );
          if (chunk.trim().length > 0) {
            emitSourceChunk(chunk, start, nextStart);
          }
          start = nextStart;
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
          ? this.#pickPreferredBreakIndex(view, unsafe, chunking, false, 1, start, openFence)
          : this.#pickBreakIndex(
              view,
              spans,
              chunking,
              force ? 1 : undefined,
              start,
              maxChars - reopenPrefix.length,
              openFence,
            );
      if (breakResult.index <= 0) {
        if (force) {
          emitSourceChunk(`${reopenPrefix}${source.slice(start)}`, start, source.length);
          start = source.length;
          reopenFence = undefined;
        }
        break;
      }

      if (breakResult.fenceSplit) {
        const boundary = indentedCode.codeBoundary(
          originalIndex(start + breakResult.index),
          originalIndex(start + 1),
        );
        let removedLength = 0;
        for (const removed of removedFenceInfo) {
          if (removed.at + removedLength <= boundary) {
            removedLength += removed.length;
          }
        }
        breakResult.index = sliceUtf16Safe(view, 0, boundary - removedLength - start).length;
      }

      const consumed = this.#resolveBreakResult({
        breakResult,
        reopenPrefix,
        source,
        start,
      });
      if (consumed === null) {
        continue;
      }
      if (consumed.chunk) {
        emitSourceChunk(consumed.chunk, start, consumed.start);
      }
      start = consumed.start;
      reopenFence = consumed.reopenFence;

      const nextLength =
        (reopenFence ? `${reopenFence.reopenFenceLine}\n`.length : 0) + (source.length - start);
      if (nextLength < minChars && !force) {
        break;
      }
      if (nextLength < maxChars && !force && !chunking.flushOnParagraph) {
        break;
      }
    }
    if (!reopenFence) {
      start = skipLeadingNewlines(source, start);
    }
    if (start === 0) {
      return;
    }
    const consumed = sourceOffset(start);
    if (consumed > 0) {
      this.#bufferStartsAtLineStart = this.#buffer.charAt(consumed - 1) === "\n";
    }
    this.#codeContext = indentedCode.contextAt(consumed + this.#reopenPrefix.length);
    this.#consumedLength += consumed;
    this.#buffer = this.#buffer.slice(consumed);
    this.#reopenPrefix =
      !this.#codeContext && reopenFence ? `${reopenFence.reopenFenceLine}\n` : "";
  }

  #resolveBreakResult(params: {
    breakResult: BreakResult;
    reopenPrefix: string;
    source: string;
    start: number;
  }): { chunk?: string; start: number; reopenFence?: FenceSplit } | null {
    const { breakResult, reopenPrefix, source, start } = params;
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
        ? fenceSplit.closeFenceLine
        : `\n${fenceSplit.closeFenceLine}`;
      rawChunk = `${rawChunk}${closeFence}`;
      const closeFenceStart = findFenceCloseLineStart(source, fenceSplit.fence);
      if (absoluteBreakIdx === closeFenceStart) {
        // The synthetic closer already owns this boundary; replaying the source
        // closer after reopening would publish an empty fenced-code message.
        return { chunk: rawChunk, start: skipLeadingNewlines(source, fenceSplit.fence.end) };
      }
      return { chunk: rawChunk, start: absoluteBreakIdx, reopenFence: fenceSplit };
    }

    const nextStart =
      absoluteBreakIdx < source.length && /\s/.test(source.charAt(absoluteBreakIdx))
        ? absoluteBreakIdx + 1
        : absoluteBreakIdx;
    return {
      chunk: rawChunk,
      start: skipLeadingNewlines(source, nextStart),
      reopenFence: undefined,
    };
  }

  // Forced tails take the first paragraph/newline break; capped windows take the last.
  #pickPreferredBreakIndex(
    buffer: string,
    unsafeSpans: readonly BreakSpan[],
    chunking: BlockReplyChunking,
    reverse: boolean,
    minCharsOverride?: number,
    offset = 0,
    openFence?: FenceSpan,
  ): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? chunking.minChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const preference = chunking.breakPreference ?? "paragraph";

    const separators: Array<"\n" | "\n\n"> =
      preference === "paragraph" ? ["\n\n", "\n"] : preference === "newline" ? ["\n"] : [];
    for (const separator of separators) {
      const index = findSafeLineBreakIndex({
        text: buffer,
        unsafeSpans,
        minChars,
        reverse,
        separator,
        offset,
      });
      if (index !== -1) {
        return { index };
      }
    }

    if (preference !== "newline") {
      const sentenceIdx = findSafeSentenceBreakIndex(
        buffer,
        unsafeSpans,
        minChars,
        offset,
        openFence,
      );
      if (sentenceIdx !== -1) {
        return { index: sentenceIdx };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(
    buffer: string,
    spans: BreakSpans,
    chunking: BlockReplyChunking,
    minCharsOverride?: number,
    offset = 0,
    maxCharsOverride?: number,
    openFence?: FenceSpan,
  ): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? chunking.minChars));
    const maxChars = Math.max(1, Math.floor(maxCharsOverride ?? chunking.maxChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));

    const preferred = this.#pickPreferredBreakIndex(
      window,
      spans.unsafe,
      chunking,
      true,
      minChars,
      offset,
      openFence,
    );
    if (preferred.index !== -1) {
      return preferred;
    }

    if (buffer.length < maxChars) {
      return { index: -1 };
    }

    const tableBreak = findTableBreakIndex(buffer, offset, window.length, spans);
    if (tableBreak !== undefined) {
      return { index: tableBreak };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window.charAt(i)) && isSafeFenceBreak(spans.unsafe, offset + i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      const firstCodePointWidth = (buffer.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      const forcedBreakIndex = sliceUtf16Safe(
        buffer,
        0,
        Math.max(maxChars, firstCodePointWidth),
      ).length;
      // An unfinished span ends at the buffer boundary without a source closer.
      const absoluteBreakIndex = offset + forcedBreakIndex;
      const fence =
        findFenceSpanAt(spans.fences, absoluteBreakIndex) ??
        (openFence?.end === absoluteBreakIndex ? openFence : undefined);
      if (fence) {
        const reopenFenceLine = resolveFenceReopenLine(fence, chunking.maxChars);
        if (!reopenFenceLine) {
          return { index: forcedBreakIndex };
        }
        // Synthetic fence wrappers consume the same transport budget as source
        // text; reserving them here keeps every emitted payload deliverable.
        const closeFenceLine = `${fence.indent}${fence.marker}`;
        const fenceBreakIndex = sliceUtf16Safe(
          buffer,
          0,
          Math.max(1, maxChars - closeFenceLine.length - 1),
        ).length;
        if (fenceBreakIndex <= 0) {
          return { index: forcedBreakIndex };
        }
        const closeFenceStart = findFenceCloseLineStart(buffer, fence, offset);
        return {
          index:
            closeFenceStart >= minChars && closeFenceStart <= fenceBreakIndex
              ? closeFenceStart
              : fenceBreakIndex,
          fenceSplit: { closeFenceLine, reopenFenceLine, fence },
        };
      }
      return { index: forcedBreakIndex };
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

function findNextParagraphBreak(
  buffer: string,
  fenceSpans: FenceSpan[],
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
    const index = match.index;
    if (index - startIndex < minCharsFromStart) {
      continue;
    }
    const fence = findFenceSpanAt(fenceSpans, index);
    if (fence) {
      re.lastIndex = fence.end;
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
