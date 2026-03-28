/**
 * IRC chunker that preserves newlines for draft/multiline support.
 * Based on OpenClaw's chunkMarkdownText but modified to NOT break on newlines.
 */

type FenceSpan = {
  start: number;
  end: number;
  openLine: string;
  marker: string;
  indent: string;
};

function parseFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open: { start: number; markerChar: string; markerLen: number; openLine: string; marker: string; indent: string } | undefined;
  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const indent = match[1];
      const marker = match[2];
      const markerChar = marker[0];
      const markerLen = marker.length;
      if (!open) {
        open = { start: offset, markerChar, markerLen, openLine: line, marker, indent };
      } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
        const end = lineEnd;
        spans.push({ start: open.start, end, openLine: open.openLine, marker: open.marker, indent: open.indent });
        open = undefined;
      }
    }
    if (nextNewline === -1) break;
    offset = nextNewline + 1;
  }
  if (open) {
    spans.push({ start: open.start, end: buffer.length, openLine: open.openLine, marker: open.marker, indent: open.indent });
  }
  return spans;
}

function findFenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) break;
    if (index <= span.start) {
      high = mid - 1;
      continue;
    }
    if (index >= span.end) {
      low = mid + 1;
      continue;
    }
    return span;
  }
  return undefined;
}

function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
  return !findFenceSpanAt(spans, index);
}

function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];
  return undefined;
}

function skipLeadingNewlines(value: string, start: number = 0): number {
  let i = start;
  while (i < value.length && value[i] === "\n") i++;
  return i;
}

function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
  isAllowed: (index: number) => boolean = () => true
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;
  for (let i = start; i < end; i++) {
    if (!isAllowed(i)) continue;
    const char = text[i];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === "\n") lastNewline = i;
    else if (/\s/.test(char)) lastWhitespace = i;
  }
  return { lastNewline, lastWhitespace };
}

/**
 * Pick a safe break index - MODIFIED to NOT break on newlines.
 * Only uses whitespace (spaces, tabs) for breaking, preserving newlines for draft/multiline.
 */
function pickSafeBreakIndex(text: string, start: number, end: number, spans: FenceSpan[]): number {
  const { lastWhitespace } = scanParenAwareBreakpoints(text, start, end, (index) => isSafeFenceBreak(spans, index));
  // Don't break on newlines - preserve them for draft/multiline
  if (lastWhitespace > start) return lastWhitespace;
  return -1;
}

/**
 * Chunk text for IRC, preserving newlines for draft/multiline support.
 * Uses the configured limit from the plugin.
 */
export function chunk(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) return early;

  const chunks: string[] = [];
  const spans = parseFenceSpans(text);
  let start = 0;
  let reopenFence: FenceSpan | undefined;

  while (start < text.length) {
    const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : "";
    const contentLimit = Math.max(1, limit - reopenPrefix.length);

    if (text.length - start <= contentLimit) {
      const finalChunk = `${reopenPrefix}${text.slice(start)}`;
      if (finalChunk.length > 0) chunks.push(finalChunk);
      break;
    }

    const windowEnd = Math.min(text.length, start + contentLimit);
    const softBreak = pickSafeBreakIndex(text, start, windowEnd, spans);
    let breakIdx = softBreak > start ? softBreak : windowEnd;

    const initialFence = isSafeFenceBreak(spans, breakIdx) ? undefined : findFenceSpanAt(spans, breakIdx);
    let fenceToSplit = initialFence;

    if (initialFence) {
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = start + (contentLimit - (closeLine.length + 1));
      if (maxIdxIfNeedNewline <= start) {
        fenceToSplit = undefined;
        breakIdx = windowEnd;
      } else {
        const minProgressIdx = Math.min(
          text.length,
          Math.max(start + 1, initialFence.start + initialFence.openLine.length + 2)
        );
        const maxIdxIfAlreadyNewline = start + (contentLimit - closeLine.length);
        let pickedNewline = false;
        let lastNewline = text.lastIndexOf("\n", Math.max(start, maxIdxIfAlreadyNewline - 1));
        while (lastNewline >= start) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < minProgressIdx) break;
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = candidateBreak;
            pickedNewline = true;
            break;
          }
          lastNewline = text.lastIndexOf("\n", lastNewline - 1);
        }
        if (!pickedNewline) {
          if (minProgressIdx > maxIdxIfAlreadyNewline) {
            fenceToSplit = undefined;
            breakIdx = windowEnd;
          } else {
            breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
          }
        }
        const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
        fenceToSplit =
          fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
      }
    }

    const rawContent = text.slice(start, breakIdx);
    if (!rawContent) break;

    let rawChunk = `${reopenPrefix}${rawContent}`;
    const brokeOnSeparator = breakIdx < text.length && /\s/.test(text[breakIdx]);
    let nextStart = Math.min(text.length, breakIdx + (brokeOnSeparator ? 1 : 0));

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      reopenFence = fenceToSplit;
    } else {
      nextStart = skipLeadingNewlines(text, nextStart);
      reopenFence = undefined;
    }

    chunks.push(rawChunk);
    start = nextStart;
  }

  return chunks;
}
