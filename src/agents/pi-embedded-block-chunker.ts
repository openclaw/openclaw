import type { FenceSpan } from "../markdown/fences.js";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "../markdown/fences.js";

export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
  /** When true, flush eagerly on \n\n paragraph boundaries regardless of minChars. */
  flushOnParagraph?: boolean;
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

type ParagraphBreak = {
  index: number;
  length: number;
};

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

    // When flushOnParagraph is set (chunkMode="newline"), eagerly split on \n\n
    // boundaries regardless of minChars so each paragraph is sent immediately.
    if (this.#chunking.flushOnParagraph && !force) {
      this.#drainParagraphs(emit, maxChars);
      return;
    }

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

    while (this.#buffer.length >= minChars || (force && this.#buffer.length > 0)) {
      const breakResult =
        force && this.#buffer.length <= maxChars
          ? this.#pickSoftBreakIndex(this.#buffer, 1)
          : this.#pickBreakIndex(this.#buffer, force ? 1 : undefined);
      if (breakResult.index <= 0) {
        if (force) {
          emit(this.#buffer);
          this.#buffer = "";
        }
        return;
      }

      if (!this.#emitBreakResult(breakResult, emit)) {
        continue;
      }

      if (this.#buffer.length < minChars && !force) {
        return;
      }
      if (this.#buffer.length < maxChars && !force) {
        return;
      }
    }
  }

  /** Eagerly emit complete paragraphs (text before \n\n) regardless of minChars. */
  #drainParagraphs(emit: (chunk: string) => void, maxChars: number) {
    while (this.#buffer.length > 0) {
      const fenceSpans = parseFenceSpans(this.#buffer);
      const paragraphBreak = findNextParagraphBreak(this.#buffer, fenceSpans);
      if (!paragraphBreak || paragraphBreak.index > maxChars) {
        // No paragraph boundary yet (or the next boundary is too far). If the
        // buffer exceeds maxChars, fall back to normal break logic to avoid
        // oversized chunks or unbounded accumulation.
        if (this.#buffer.length >= maxChars) {
          const breakResult = this.#pickBreakIndex(this.#buffer, 1);
          if (breakResult.index > 0) {
            this.#emitBreakResult(breakResult, emit);
            continue;
          }
        }
        return;
      }

      const chunk = this.#buffer.slice(0, paragraphBreak.index);
      if (chunk.trim().length > 0) {
        emit(chunk);
      }
      this.#buffer = stripLeadingNewlines(
        this.#buffer.slice(paragraphBreak.index + paragraphBreak.length),
      );
    }
  }

  #emitBreakResult(breakResult: BreakResult, emit: (chunk: string) => void): boolean {
    const breakIdx = breakResult.index;
    if (breakIdx <= 0) {
      return false;
    }

    let rawChunk = this.#buffer.slice(0, breakIdx);
    if (rawChunk.trim().length === 0) {
      this.#buffer = stripLeadingNewlines(this.#buffer.slice(breakIdx)).trimStart();
      return false;
    }

    let nextBuffer = this.#buffer.slice(breakIdx);
    const fenceSplit = breakResult.fenceSplit;
    if (fenceSplit) {
      const closeFence = rawChunk.endsWith("\n")
        ? `${fenceSplit.closeFenceLine}\n`
        : `\n${fenceSplit.closeFenceLine}\n`;
      rawChunk = `${rawChunk}${closeFence}`;

      const reopenFence = fenceSplit.reopenFenceLine.endsWith("\n")
        ? fenceSplit.reopenFenceLine
        : `${fenceSplit.reopenFenceLine}\n`;
      nextBuffer = `${reopenFence}${nextBuffer}`;
    }

    emit(rawChunk);

    if (fenceSplit) {
      this.#buffer = nextBuffer;
    } else {
      const nextStart =
        breakIdx < this.#buffer.length && /\s/.test(this.#buffer[breakIdx])
          ? breakIdx + 1
          : breakIdx;
      this.#buffer = stripLeadingNewlines(this.#buffer.slice(nextStart));
    }

    return true;
  }

  #pickSoftBreakIndex(buffer: string, minCharsOverride?: number): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const fenceSpans = parseFenceSpans(buffer);
    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      let paragraphIdx = buffer.indexOf("\n\n");
      while (paragraphIdx !== -1) {
        const candidates = [paragraphIdx, paragraphIdx + 1];
        for (const candidate of candidates) {
          if (candidate < minChars) {
            continue;
          }
          if (candidate < 0 || candidate >= buffer.length) {
            continue;
          }
          if (isSafeFenceBreak(fenceSpans, candidate)) {
            return { index: candidate };
          }
        }
        paragraphIdx = buffer.indexOf("\n\n", paragraphIdx + 2);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (newlineIdx >= minChars && isSafeFenceBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }
    }

    if (preference !== "newline") {
      const matches = buffer.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) {
          continue;
        }
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) {
        return { index: sentenceIdx };
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(buffer: string, minCharsOverride?: number): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));
    const fenceSpans = parseFenceSpans(buffer);

    const preference = this.#chunking.breakPreference ?? "paragraph";
    if (preference === "paragraph") {
      let paragraphIdx = window.lastIndexOf("\n\n");
      while (paragraphIdx >= minChars) {
        const candidates = [paragraphIdx, paragraphIdx + 1];
        for (const candidate of candidates) {
          if (candidate < minChars) {
            continue;
          }
          if (candidate < 0 || candidate >= buffer.length) {
            continue;
          }
          if (isSafeFenceBreak(fenceSpans, candidate)) {
            return { index: candidate };
          }
        }
        paragraphIdx = window.lastIndexOf("\n\n", paragraphIdx - 1);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (isSafeFenceBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }
    }

    if (preference !== "newline") {
      const matches = window.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) {
          continue;
        }
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) {
        return { index: sentenceIdx };
      }
    }

    if (preference === "newline" && buffer.length < maxChars) {
      return { index: -1 };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeFenceBreak(fenceSpans, i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeFenceBreak(fenceSpans, maxChars)) {
        return { index: maxChars };
      }
      const fence = findFenceSpanAt(fenceSpans, maxChars);
      if (fence) {
        return {
          index: maxChars,
          fenceSplit: {
            closeFenceLine: `${fence.indent}${fence.marker}`,
            reopenFenceLine: fence.openLine,
          },
        };
      }
      return { index: maxChars };
    }

    return { index: -1 };
  }
}

function stripLeadingNewlines(value: string): string {
  let i = 0;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i > 0 ? value.slice(i) : value;
}

function findNextParagraphBreak(
  buffer: string,
  fenceSpans: FenceSpan[],
  startIndex = 0,
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
    if (!isSafeFenceBreak(fenceSpans, index)) {
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
