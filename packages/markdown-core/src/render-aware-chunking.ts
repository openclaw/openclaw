import { findGraphemeChunkEnd } from "@openclaw/normalization-core/grapheme";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { annotateAssistantTranscriptRoleMessageBoundary } from "./ir-annotations.js";
import { sliceMarkdownIRRanges } from "./ir-slice.js";
import { mergeAnnotationSpans, mergeStyleSpans } from "./ir-spans.js";
import { appendMarkdownIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";

export type RenderedMarkdownChunk<TRendered> = {
  /** Rendered payload for this chunk after caller-specific escaping/link rewriting. */
  rendered: TRendered;
  source: MarkdownIR;
};

export type RenderMarkdownIRChunksWithinLimitOptions<TRendered> = {
  ir: MarkdownIR;
  /** Maximum measured size for each rendered chunk. */
  limit: number;
  /** Returns the size unit enforced by the target transport. */
  measureRendered: (rendered: TRendered) => number;
  renderChunk: (ir: MarkdownIR) => TRendered;
  /** Re-annotate transcript-role headers promoted by a new message boundary. */
  assistantTranscriptRoleMessageBoundaries?: boolean;
};

type RenderedCandidate<TRendered> = {
  rawSource: MarkdownIR;
  output: RenderedMarkdownChunk<TRendered>;
};

function renderCandidate<TRendered>(
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
  rawSource: MarkdownIR,
): RenderedCandidate<TRendered> {
  const source =
    options.assistantTranscriptRoleMessageBoundaries === true
      ? annotateAssistantTranscriptRoleMessageBoundary(rawSource)
      : rawSource;
  return { rawSource, output: { source, rendered: options.renderChunk(source) } };
}

/** Chunks Markdown IR by rendered size while preserving styles, links, and whitespace. */
export function renderMarkdownIRChunksWithinLimit<TRendered>(
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
): RenderedMarkdownChunk<TRendered>[] {
  if (!options.ir.text) {
    return [];
  }

  // Callers pass Infinity to mean "no size cap" (e.g. a media caption that must not be
  // split). resolveIntegerOption rejects non-finite values and would fall back to 1,
  // shattering the text into one chunk per character; emit the whole IR as one chunk.
  if (options.limit === Number.POSITIVE_INFINITY) {
    return [renderCandidate(options, options.ir).output];
  }

  const normalizedLimit = resolveIntegerOption(options.limit, 1, { min: 1 });
  // Treat the pending worklist as a stack so each dequeue/enqueue stays O(1).
  // The initial reverse keeps the final order stable while avoiding shift/unshift
  // moving every remaining chunk for long messages.
  const pending = splitMarkdownIRPreserveWhitespace(options.ir, normalizedLimit).toReversed();
  const finalized: RenderedCandidate<TRendered>[] = [];
  let sourceOffset = 0;

  for (let chunk = pending.pop(); chunk; chunk = pending.pop()) {
    const candidate = renderCandidate(options, chunk);
    if (
      options.measureRendered(candidate.output.rendered) <= normalizedLimit ||
      chunk.text.length <= 1
    ) {
      finalized.push(candidate);
      sourceOffset += chunk.text.length;
      continue;
    }

    const split = splitMarkdownIRByRenderedLimit(chunk, normalizedLimit, options);
    if (split.length <= 1) {
      // Worst-case safety: avoid retry loops and keep the original chunk.
      finalized.push(candidate);
      sourceOffset += chunk.text.length;
      continue;
    }
    const remainder = split.at(-1);
    if (remainder && pending.length > 0) {
      // The retry's final slice is overflow, not a message boundary. Refill it
      // from pending source windows before applying the ordinary split rules.
      const start = sourceOffset + chunk.text.length - remainder.text.length;
      let end = sourceOffset + chunk.text.length;
      while (pending.length > 0 && end - start < normalizedLimit) {
        const next = pending.pop();
        if (next) {
          end += next.text.length;
        }
      }
      const carried = sliceMarkdownIR(options.ir, start, end);
      split.pop();
      pending.push(...splitMarkdownIRPreserveWhitespace(carried, normalizedLimit).toReversed());
    }
    for (const next of split.toReversed()) {
      pending.push(next);
    }
  }

  return coalesceWhitespaceOnlyMarkdownIRChunks(finalized, normalizedLimit, options).map(
    (chunk) => chunk.output,
  );
}

function splitMarkdownIRByRenderedLimit<TRendered>(
  chunk: MarkdownIR,
  renderedLimit: number,
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
): MarkdownIR[] {
  const currentTextLength = chunk.text.length;
  const fits = (source: MarkdownIR) =>
    options.measureRendered(renderCandidate(options, source).output.rendered) <= renderedLimit;
  const safeCandidateLength = findFittingPrefixLength(chunk, fits);
  if (safeCandidateLength === 0) {
    return [chunk];
  }
  const split = splitMarkdownIRPreserveWhitespace(chunk, safeCandidateLength);
  const firstChunk = split[0];
  if (firstChunk && fits(firstChunk)) {
    return split;
  }
  return [
    sliceMarkdownIR(chunk, 0, safeCandidateLength),
    sliceMarkdownIR(chunk, safeCandidateLength, currentTextLength),
  ];
}

function findFittingPrefixLength(chunk: MarkdownIR, fits: (source: MarkdownIR) => boolean): number {
  const { text } = chunk;
  const fitsAt = (length: number) => fits(sliceMarkdownIR(chunk, 0, length));
  // Each probe renders a whole prefix, so testing every length is quadratic.
  // Escaping, auto-link, and file-reference rewriting can make a longer prefix
  // render shorter, but only by rewriting a whitespace-delimited token or a
  // `<...>` token by what surrounds it. Bisect token starts, where every earlier
  // token is complete and followed by whitespace, then test exact lengths below
  // the first overflowing start from longest to shortest. The caller already
  // measured the full chunk as overflowing.
  const starts = findTokenStarts(text);
  let fitting = -1;
  let overflowing = starts.length;
  let fittingLength = 0;
  while (overflowing - fitting > 1) {
    const index = fitting + Math.floor((overflowing - fitting) / 2);
    const length = findGraphemeChunkEnd(text, 0, starts[index] ?? text.length);
    if (fitsAt(length)) {
      fitting = index;
      fittingLength = length;
    } else {
      overflowing = index;
    }
  }

  const upperLength = starts[overflowing] ?? text.length;
  for (let candidateLength = upperLength - 1; candidateLength >= 1; candidateLength -= 1) {
    const safeCandidateLength = findGraphemeChunkEnd(text, 0, candidateLength);
    if (safeCandidateLength <= fittingLength) {
      break;
    }
    if (fitsAt(safeCandidateLength)) {
      return safeCandidateLength;
    }
    candidateLength = Math.min(candidateLength, safeCandidateLength);
  }
  return fittingLength;
}

function findTokenStarts(text: string): number[] {
  // Slack keeps a complete `<https://...|label>` or mention token raw but
  // escapes a partial one, so a label with spaces stays one token.
  const angleTokens = Array.from(text.matchAll(/<[^\s>][^>\n]*>/g), ({ index, 0: token }) => ({
    start: index,
    end: index + token.length,
  }));
  const starts: number[] = [];
  for (let index = 1; index < text.length; index += 1) {
    if (
      /\s/.test(text[index - 1] ?? "") &&
      !angleTokens.some((token) => token.start < index && index < token.end)
    ) {
      starts.push(index);
    }
  }
  return starts;
}

function findMarkdownIRPreservedSplitIndex(text: string, start: number, limit: number): number {
  const maxEnd = Math.min(text.length, start + limit);
  if (maxEnd >= text.length) {
    return text.length;
  }

  let lastOutsideParenNewlineBreak = -1;
  let lastOutsideParenWhitespaceBreak = -1;
  let lastOutsideParenWhitespaceRunStart = -1;
  let lastAnyNewlineBreak = -1;
  let lastAnyWhitespaceBreak = -1;
  let lastAnyWhitespaceRunStart = -1;
  let parenDepth = 0;
  let sawNonWhitespace = false;

  for (let index = start; index < maxEnd; index += 1) {
    const char = text.charAt(index);
    // Parenthesized text often carries rewritten file/link references; prefer
    // keeping it intact unless no outside break exists in the current window.
    if (char === "(") {
      sawNonWhitespace = true;
      parenDepth += 1;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      sawNonWhitespace = true;
      parenDepth -= 1;
      continue;
    }
    if (!/\s/.test(char)) {
      sawNonWhitespace = true;
      continue;
    }
    if (!sawNonWhitespace) {
      continue;
    }
    if (char === "\n") {
      // Newlines preserve markdown block structure better than other spaces.
      lastAnyNewlineBreak = index + 1;
      if (parenDepth === 0) {
        lastOutsideParenNewlineBreak = index + 1;
      }
      continue;
    }
    const whitespaceRunStart =
      index === start || !/\s/.test(text[index - 1] ?? "") ? index : lastAnyWhitespaceRunStart;
    lastAnyWhitespaceBreak = index + 1;
    lastAnyWhitespaceRunStart = whitespaceRunStart;
    if (parenDepth === 0) {
      lastOutsideParenWhitespaceBreak = index + 1;
      lastOutsideParenWhitespaceRunStart = whitespaceRunStart;
    }
  }

  const resolveWhitespaceBreak = (breakIndex: number, runStart: number): number => {
    if (runStart <= start) {
      return breakIndex;
    }
    return /\s/.test(text[breakIndex] ?? "") ? runStart : breakIndex;
  };

  if (lastOutsideParenNewlineBreak > start) {
    return lastOutsideParenNewlineBreak;
  }
  if (lastOutsideParenWhitespaceBreak > start) {
    return resolveWhitespaceBreak(
      lastOutsideParenWhitespaceBreak,
      lastOutsideParenWhitespaceRunStart,
    );
  }
  if (lastAnyNewlineBreak > start) {
    return lastAnyNewlineBreak;
  }
  if (lastAnyWhitespaceBreak > start) {
    return resolveWhitespaceBreak(lastAnyWhitespaceBreak, lastAnyWhitespaceRunStart);
  }
  return maxEnd;
}

function splitMarkdownIRPreserveWhitespace(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }
  if (ir.text.length <= limit) {
    return [ir];
  }

  const codeSpans = ir.styles
    .filter((span) => span.style === "code" || span.style === "code_block")
    .toSorted((left, right) => left.start - right.start);
  let codeIndex = 0;
  const ranges: SourceRange[] = [];
  let cursor = 0;
  while (cursor < ir.text.length) {
    const maxEnd = Math.min(ir.text.length, cursor + limit);
    let preferredEnd = findMarkdownIRPreservedSplitIndex(ir.text, cursor, limit);
    let code = codeSpans[codeIndex];
    while (code && code.end <= preferredEnd) {
      code = codeSpans[++codeIndex];
    }
    if (code && code.start < preferredEnd && preferredEnd < code.end) {
      // Transport trimming must not turn an internal code separator into message padding.
      let codeEnd = maxEnd;
      while (
        codeEnd > cursor &&
        (/\s/u.test(ir.text[codeEnd - 1] ?? "") || /\s/u.test(ir.text[codeEnd] ?? ""))
      ) {
        codeEnd -= 1;
      }
      codeEnd = findGraphemeChunkEnd(ir.text, cursor, codeEnd, codeEnd, false);
      let nextContent = maxEnd;
      const nextMaxEnd = Math.min(ir.text.length, codeEnd + limit);
      while (nextContent < nextMaxEnd && /\s/u.test(ir.text[nextContent] ?? "")) {
        nextContent += 1;
      }
      // Keep the existing progress rule when whitespace and its context cannot fit.
      if (
        codeEnd > cursor &&
        findGraphemeChunkEnd(ir.text, codeEnd, nextMaxEnd, undefined, false) > nextContent
      ) {
        preferredEnd = codeEnd;
      }
    }
    const end = findGraphemeChunkEnd(ir.text, cursor, maxEnd, preferredEnd);
    ranges.push({ start: cursor, end });
    cursor = end;
  }
  return sliceMarkdownIRRanges(ir, ranges);
}

type SourceRange = { start: number; end: number };

function coalesceWhitespaceOnlyMarkdownIRChunks<TRendered>(
  chunks: RenderedCandidate<TRendered>[],
  renderedLimit: number,
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
): RenderedCandidate<TRendered>[] {
  // Finalized slices partition the source; only coalescing can discard separators.
  let offset = 0;
  const pending = chunks.map((chunk) => {
    const start = offset;
    offset += chunk.rawSource.text.length;
    return { ...chunk, start, end: offset };
  });
  const coalesced: Array<RenderedCandidate<TRendered> & { ranges: SourceRange[] }> = [];

  pending.forEach((chunk, index) => {
    const currentRange = { start: chunk.start, end: chunk.end };
    const current = { ...chunk, ranges: [currentRange] };
    if (chunk.rawSource.text.trim().length > 0) {
      coalesced.push(current);
      return;
    }

    const prev = coalesced.at(-1);
    const next = pending[index + 1];
    const chunkLength = chunk.rawSource.text.length;

    const renderIfFits = (ranges: SourceRange[]) => {
      const retained: SourceRange[] = [];
      for (const range of ranges) {
        const last = retained.at(-1);
        if (last?.end === range.start) {
          last.end = range.end;
        } else {
          retained.push({ ...range });
        }
      }
      // Slice contiguous source once, but never restore a discarded separator gap.
      // Raw source also excludes annotations introduced only by a message boundary.
      const source: MarkdownIR = { text: "", styles: [], links: [] };
      for (const range of retained) {
        appendMarkdownIR(source, sliceMarkdownIR(options.ir, range.start, range.end));
      }
      source.styles = mergeStyleSpans(source.styles);
      if (source.annotations) {
        source.annotations = mergeAnnotationSpans(source.annotations);
      }
      const candidate = renderCandidate(options, source);
      return options.measureRendered(candidate.output.rendered) <= renderedLimit
        ? { ...candidate, ranges: retained }
        : undefined;
    };

    if (prev) {
      const mergedPrev = renderIfFits([...prev.ranges, currentRange]);
      if (mergedPrev) {
        coalesced[coalesced.length - 1] = mergedPrev;
        return;
      }
    }

    if (next) {
      const mergedNext = renderIfFits([{ start: chunk.start, end: next.end }]);
      if (mergedNext) {
        pending[index + 1] = { ...mergedNext, start: chunk.start, end: next.end };
        return;
      }
    }

    if (prev && next) {
      // Redistribute only complete graphemes; a CRLF separator is indivisible.
      for (let prefixLength = chunkLength - 1; prefixLength > 0; prefixLength -= 1) {
        prefixLength = findGraphemeChunkEnd(
          chunk.rawSource.text,
          0,
          prefixLength,
          prefixLength,
          false,
        );
        if (prefixLength === 0) {
          break;
        }
        const boundary = chunk.start + prefixLength;
        const mergedPrev = renderIfFits([...prev.ranges, { start: chunk.start, end: boundary }]);
        const mergedNext = mergedPrev && renderIfFits([{ start: boundary, end: next.end }]);
        if (mergedPrev && mergedNext) {
          coalesced[coalesced.length - 1] = mergedPrev;
          pending[index + 1] = { ...mergedNext, start: boundary, end: next.end };
          return;
        }
      }
    }

    // Preserve zero chunks when a renderer trims semantic whitespace away.
    if (
      options.measureRendered(chunk.output.rendered) > 0 &&
      (chunk.rawSource.styles.length > 0 ||
        chunk.rawSource.links.length > 0 ||
        chunk.rawSource.annotations?.length ||
        chunk.rawSource.listItems?.length)
    ) {
      coalesced.push(current);
    }
  });

  return coalesced;
}
