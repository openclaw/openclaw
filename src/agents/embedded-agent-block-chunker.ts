import {
  findGraphemeChunkEnd,
  firstGraphemeClusterLength,
} from "@openclaw/normalization-core/grapheme";
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
  findTableContinuationAtBoundary,
  findTableContinuationHeader,
  findTableSpans,
  resolveTableContinuation,
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
  /** Only for cumulative previews that replace previously emitted text. */
  mutablePreview?: boolean;
  emit: (chunk: string, options?: BlockChunkMetadata) => void;
};

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
  #tableHeader = "";
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
    this.#tableHeader = "";
    this.#consumedLength = 0;
    this.#preparedSourceBreaks = [];
    this.#sourceBreaks = sourceBreaks;
    this.#sourceGeneration += 1;
    this.#sourceOffset = sourceOffset;
    this.#nextSourceBreak = 0;
    this.#bufferStartsAtLineStart = true;
    this.#codeContext = "";
  }

  /** UTF-16 source positions exclude synthetic framing and include skipped whitespace. */
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
    const readMaxChars = () =>
      Math.max(
        1,
        Math.floor(this.#chunking?.minChars ?? 1),
        Math.floor(this.#chunking?.maxChars ?? Infinity),
      );
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
      const maxChars = readMaxChars();
      const reopenLine =
        fence && this.#chunking ? resolveFenceReopenLine(fence, maxChars) : undefined;
      this.#reopenPrefix = reopenLine ? `${reopenLine}\n` : "";
      this.#codeContext = prepareIndentedCode(text, "", true, maxChars).contextAt(text.length);
    }
    const consumedLength = Math.min(this.#consumedLength, sourceOffset + text.length);
    if (this.#tableHeader && sourceOffset === 0 && !prefixRetained) {
      this.#tableHeader = findTableContinuationAtBoundary(
        text.slice(0, consumedLength),
        readMaxChars(),
      );
    }
    if (!prefixRetained && sourceOffset === 0 && this.#codeContext && consumedLength > 0) {
      const maxChars = readMaxChars();
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
    return this.#buffer ? `${this.#reopenPrefix || this.#tableHeader}${this.#buffer}` : "";
  }

  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

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
    const minChars = Math.max(1, Math.floor(chunking?.minChars ?? 1));
    const maxChars = Math.max(minChars, Math.floor(chunking?.maxChars ?? Infinity));
    const sourceBoundaryLength = (value: string, start: number) =>
      value.slice(start).match(/^(?:\n[\t ]*)+/)?.[0].length ?? 0;
    const nextTextStart = (value: string, start: number) => {
      const length = sourceBoundaryLength(value, start);
      // A standalone whitespace message is not deliverable; retain separators
      // with the next content whenever they fit within the transport cap.
      return (params.force && start + length === value.length) || length >= maxChars
        ? start + length
        : start;
    };
    this.#tableHeader = resolveTableContinuation(
      this.#tableHeader,
      this.#buffer,
      params.force || this.#buffer.length + this.#tableHeader.length >= maxChars,
    );
    const syntheticPrefix = this.#reopenPrefix || this.#tableHeader;
    const emitChunk = (chunk: string, from: number, to: number, startsAtLineStart: boolean) => {
      preparedSourceBreaks.push(sourceStart + to);
      emit(chunk, {
        sourceText: this.#buffer.slice(from, to),
        sourceGeneration: this.#sourceGeneration,
        reconciledSourceBreak: reconciledSourceBreak || undefined,
        sourceStart: this.#sourceOffset + this.#consumedLength + from,
        sourceEnd: this.#sourceOffset + this.#consumedLength + to,
        startsAtLineStart,
      });
    };
    if (!chunking) {
      emitChunk(
        this.bufferedText,
        0,
        this.#buffer.length,
        Boolean(syntheticPrefix) || this.#bufferStartsAtLineStart,
      );
      this.#bufferStartsAtLineStart = this.#buffer.endsWith("\n");
      this.#consumedLength += this.#buffer.length;
      this.#buffer = "";
      this.#reopenPrefix = "";
      this.#tableHeader = "";
      this.#codeContext = "";
      return;
    }
    const force = params.force || availableLength >= maxChars;
    const originalSource = this.bufferedText;
    if (originalSource.length < minChars && !force) {
      return;
    }
    const indentedCode = prepareIndentedCode(originalSource, this.#codeContext, force, maxChars);
    let source = indentedCode.text;
    const startsAtLineStart =
      Boolean(syntheticPrefix) || indentedCode.startsWithCode || this.#bufferStartsAtLineStart;

    if (source.length < minChars && !force) {
      return;
    }

    const { spans: fenceSpans, state: fenceState } = scanFenceSpans(source, {
      atLineStart: startsAtLineStart,
    });
    const openFence = fenceState.open ? fenceSpans.at(-1) : undefined;
    if (force && source.length <= maxChars && !syntheticPrefix && !openFence) {
      if (source.trim().length > 0) {
        emitChunk(source, 0, this.#buffer.length, startsAtLineStart);
      }
      this.#bufferStartsAtLineStart = this.#buffer.endsWith("\n");
      this.#codeContext = indentedCode.contextAt(originalSource.length);
      this.#consumedLength += this.#buffer.length;
      this.#buffer = "";
      this.#reopenPrefix = "";
      this.#tableHeader = reconciledSourceBreak
        ? findTableContinuationAtBoundary(source, maxChars)
        : "";
      return;
    }

    // Keep original source text so shortened language hints and synthetic
    // fences cannot move the source cursor during checkpoint reconciliation.
    const removedFenceInfo: Array<{ at: number; length: number }> = [];
    let removedFenceInfoLength = 0;
    for (const fence of fenceSpans) {
      fence.start -= removedFenceInfoLength;
      fence.end -= removedFenceInfoLength;
      const reopenFenceLine = resolveFenceReopenLine(fence, maxChars);
      const closingLength = fence === openFence ? fence.indent.length + fence.marker.length + 1 : 0;
      if (
        !reopenFenceLine ||
        reopenFenceLine === fence.openLine ||
        fence.end - fence.start + closingLength <= maxChars
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
    const tables = findTableSpans(source, fenceSpans, maxChars, !force);
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
      Math.max(0, indentedCode.toSource(originalIndex(index)) - syntheticPrefix.length);
    let start = 0;
    let reopenFence: FenceSplit | undefined;
    let tableHeader = "";
    const emitSourceChunk = (chunk: string, from: number, to: number) =>
      emitChunk(
        chunk,
        sourceOffset(from),
        sourceOffset(to),
        Boolean(reopenFence || tableHeader) ||
          (from === 0 ? startsAtLineStart : source.charAt(from - 1) === "\n"),
      );
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
      const reopenPrefix = reopenFence ? `${reopenFence.reopenFenceLine}\n` : tableHeader;
      const remainingLength = reopenPrefix.length + (source.length - start);

      if (!force && remainingLength < minChars) {
        break;
      }

      if (chunking.flushOnParagraph && !force) {
        const paragraphBreak = findNextParagraphBreak(source, fenceSpans, start, minChars);
        const paragraphLimit = Math.max(1, maxChars - reopenPrefix.length);
        if (paragraphBreak !== null && paragraphBreak - start <= paragraphLimit) {
          const chunk = `${reopenPrefix}${source.slice(start, paragraphBreak)}`;
          const nextStart = nextTextStart(source, paragraphBreak);
          if (chunk.trim().length > 0) {
            emitSourceChunk(chunk, start, nextStart);
          }
          start = nextStart;
          reopenFence = undefined;
          tableHeader = "";
          continue;
        }
        if (remainingLength < maxChars) {
          break;
        }
      }

      const view = source.slice(start);
      const boundaryLength = sourceBoundaryLength(source, start);
      if (boundaryLength === view.length) {
        break;
      }
      if (boundaryLength >= maxChars - reopenPrefix.length) {
        start += boundaryLength;
        continue;
      }
      const minBreak = Math.max(force ? 1 : minChars, boundaryLength + 1);
      const breakResult =
        force && remainingLength <= maxChars && !openFence
          ? this.#pickPreferredBreakIndex(view, unsafe, chunking, false, minBreak, start, openFence)
          : this.#pickBreakIndex(
              { ...params, force },
              view,
              spans,
              chunking,
              minBreak,
              start,
              maxChars - reopenPrefix.length,
              openFence,
            );
      if (breakResult.index <= 0) {
        if (force) {
          emitSourceChunk(`${reopenPrefix}${source.slice(start)}`, start, source.length);
          start = source.length;
          reopenFence = undefined;
          tableHeader = "";
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

      if (breakResult.index <= 0) {
        continue;
      }
      const cut = start + breakResult.index;
      let nextStart = cut;
      let chunk = `${reopenPrefix}${source.slice(start, nextStart)}`;
      let nextReopenFence: FenceSplit | undefined;
      let nextTableHeader = "";
      const fenceSplit = breakResult.fenceSplit;
      if (chunk.trim().length === 0) {
        chunk = "";
        nextStart = skipLeadingNewlines(source, nextStart);
      } else if (fenceSplit) {
        chunk += chunk.endsWith("\n")
          ? fenceSplit.closeFenceLine
          : `\n${fenceSplit.closeFenceLine}`;
        if (nextStart === findFenceCloseLineStart(source, fenceSplit.fence)) {
          // The synthetic closer already owns this boundary; replaying the source
          // closer after reopening would publish an empty fenced-code message.
          nextStart = skipLeadingNewlines(source, fenceSplit.fence.end);
        } else {
          nextReopenFence = fenceSplit;
        }
      } else {
        if (nextStart < source.length && /[^\S\n]/.test(source.charAt(nextStart))) {
          nextStart += 1;
        }
        const rowStart = skipLeadingNewlines(source, nextStart);
        nextTableHeader = findTableContinuationHeader(source, cut, rowStart, tables, !force);
        // The repeated table header already supplies the continued row's line break.
        if (rowStart > cut && tables.some((table) => table.start === rowStart)) {
          // Keep a table's full row budget by attaching its separator to the
          // preceding prose, rather than moving the table's first row inward.
          const separator = source.slice(cut, rowStart);
          if (chunk.length + separator.length <= maxChars) {
            chunk += separator;
          }
          nextStart = rowStart;
        } else {
          nextStart = nextTableHeader ? rowStart : nextTextStart(source, nextStart);
        }
        const trailingBoundary = source.slice(cut, nextStart);
        if (
          nextStart === source.length &&
          /^\n[\t \n]*$/.test(trailingBoundary) &&
          chunk.length + trailingBoundary.length <= maxChars
        ) {
          chunk += trailingBoundary;
        }
      }
      if (chunk) {
        emitSourceChunk(chunk, start, nextStart);
      }
      start = nextStart;
      reopenFence = nextReopenFence;
      tableHeader = nextTableHeader;

      const nextLength =
        (reopenFence ? `${reopenFence.reopenFenceLine}\n`.length : tableHeader.length) +
        (source.length - start);
      if (
        !force &&
        (nextLength < minChars || (nextLength < maxChars && !chunking.flushOnParagraph))
      ) {
        break;
      }
    }
    if (!reopenFence) {
      start = nextTextStart(source, start);
    }
    if (start === 0) {
      return;
    }
    const consumed = sourceOffset(start);
    if (consumed > 0) {
      this.#bufferStartsAtLineStart = this.#buffer.charAt(consumed - 1) === "\n";
    }
    this.#codeContext = indentedCode.contextAt(consumed + syntheticPrefix.length);
    this.#consumedLength += consumed;
    this.#buffer = this.#buffer.slice(consumed);
    this.#reopenPrefix =
      !this.#codeContext && reopenFence ? `${reopenFence.reopenFenceLine}\n` : "";
    this.#tableHeader = this.#codeContext
      ? ""
      : tableHeader ||
        (reconciledSourceBreak ? findTableContinuationAtBoundary(source, maxChars) : "");
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
      let index = reverse ? buffer.lastIndexOf(separator) : buffer.indexOf(separator);
      while (reverse ? index >= minChars : index !== -1) {
        for (let candidate = index; candidate < index + separator.length; candidate++) {
          if (candidate >= minChars && isSafeFenceBreak(unsafeSpans, offset + candidate)) {
            // Keep a run of empty lines together on the next block. Selecting
            // its last newline would leave part of the boundary on this block.
            while (candidate > minChars && buffer[candidate - 1] === "\n") {
              if (!isSafeFenceBreak(unsafeSpans, offset + candidate - 1)) {
                break;
              }
              candidate -= 1;
            }
            return { index: candidate };
          }
        }
        index = reverse
          ? buffer.lastIndexOf(separator, index - 1)
          : buffer.indexOf(separator, index + separator.length);
      }
    }

    if (preference !== "newline") {
      const matches = buffer.matchAll(/[.!?](?=\s|$)/g);
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
      if (sentenceIdx >= minChars) {
        return { index: sentenceIdx };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(
    { force, mutablePreview }: BlockChunkDrain,
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

    if (buffer.length < maxChars && !force) {
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

    if (buffer.length >= maxChars || force) {
      const firstCodePointWidth = (buffer.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      const forcedBreakIndex = sliceUtf16Safe(
        buffer,
        0,
        Math.max(maxChars, firstCodePointWidth),
      ).length;
      // An unfinished span ends at the buffer boundary without a source closer.
      const absoluteBreakIndex = offset + forcedBreakIndex;
      const endingFence = findFenceSpanAt(spans.fences, absoluteBreakIndex - 1);
      if (endingFence?.end === absoluteBreakIndex && endingFence !== openFence) {
        return { index: forcedBreakIndex };
      }
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
      // Trailing clusters can gain combining marks or ZWJ continuations.
      // Permanent replies wait for lookahead; cumulative previews can revise them.
      const waitForBoundary = !force && !mutablePreview;
      const graphemeSource =
        !force && /[\uD800-\uDBFF]$/u.test(buffer) ? buffer.slice(0, -1) : buffer;
      const maxEnd = Math.min(forcedBreakIndex, graphemeSource.length - (waitForBoundary ? 1 : 0));
      const wholeEnd = findGraphemeChunkEnd(graphemeSource, 0, maxEnd, maxEnd, false);
      if (waitForBoundary && wholeEnd > 0 && buffer.length === forcedBreakIndex) {
        // Wait for lookahead instead of turning a full chunk into a shorter
        // prefix and a trailing fragment solely to reserve its last cluster.
        return { index: 0 };
      }
      return {
        index:
          wholeEnd ||
          (firstGraphemeClusterLength(graphemeSource) >= forcedBreakIndex ? forcedBreakIndex : 0),
      };
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
): number | null {
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
    return index;
  }
  return null;
}
