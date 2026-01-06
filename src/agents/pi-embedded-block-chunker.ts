import {
  findFenceSpanAt,
  isSafeFenceBreak,
  parseFenceSpans,
} from "../markdown/fences.js";

export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

export class EmbeddedBlockChunker {
  #buffer = "";
  readonly #chunking: BlockReplyChunking;

  constructor(chunking: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  append(text: string) {
    if (!text) return;
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
    if (this.#buffer.length < minChars && !force) return;

    while (
      this.#buffer.length >= minChars ||
      (force && this.#buffer.length > 0)
    ) {
      const breakResult =
        force && this.#buffer.length <= maxChars
          ? this.#pickSoftBreakIndex(this.#buffer, 1)
          : this.#pickBreakIndex(this.#buffer);
      if (breakResult.index <= 0) {
        if (force) {
          emit(this.#buffer);
          this.#buffer = "";
        }
        return;
      }

      const breakIdx = breakResult.index;
      let rawChunk = this.#buffer.slice(0, breakIdx);
      if (rawChunk.trim().length === 0) {
        this.#buffer = stripLeadingNewlines(
          this.#buffer.slice(breakIdx),
        ).trimStart();
        continue;
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

      if (this.#buffer.length < minChars && !force) return;
      if (this.#buffer.length < maxChars && !force) return;
    }
  }

  #pickSoftBreakIndex(buffer: string, minCharsOverride?: number): BreakResult {
    const minChars = Math.max(
      1,
      Math.floor(minCharsOverride ?? this.#chunking.minChars),
    );
    if (buffer.length < minChars) return { index: -1 };
    const fenceSpans = parseFenceSpans(buffer);
    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      let paragraphIdx = buffer.indexOf("\n\n");
      while (paragraphIdx !== -1) {
        if (
          paragraphIdx >= minChars &&
          isSafeFenceBreak(fenceSpans, paragraphIdx)
        ) {
          return { index: paragraphIdx };
        }
        paragraphIdx = buffer.indexOf("\n\n", paragraphIdx + 2);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (
          newlineIdx >= minChars &&
          isSafeFenceBreak(fenceSpans, newlineIdx)
        ) {
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
        if (at < minChars) continue;
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) return { index: sentenceIdx };
    }

    return { index: -1 };
  }

  #pickBreakIndex(buffer: string): BreakResult {
    const minChars = Math.max(1, Math.floor(this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    if (buffer.length < minChars) return { index: -1 };
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));
    const fenceSpans = parseFenceSpans(buffer);

    const preference = this.#chunking.breakPreference ?? "paragraph";
    if (preference === "paragraph") {
      let paragraphIdx = window.lastIndexOf("\n\n");
      while (paragraphIdx >= minChars) {
        if (isSafeFenceBreak(fenceSpans, paragraphIdx)) {
          return { index: paragraphIdx };
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
        if (at < minChars) continue;
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) return { index: sentenceIdx };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeFenceBreak(fenceSpans, i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeFenceBreak(fenceSpans, maxChars)) return { index: maxChars };
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
  while (i < value.length && value[i] === "\n") i++;
  return i > 0 ? value.slice(i) : value;
}
