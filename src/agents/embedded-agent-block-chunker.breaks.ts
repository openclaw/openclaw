import type { FenceSpan } from "../../packages/markdown-core/src/fences.js";
import { isSafeFenceBreak } from "../../packages/markdown-core/src/fences.js";

export function normalizeChunkLimits(params: {
  minChars: number;
  maxChars: number;
  hardMaxChars?: number;
}): { minChars: number; maxChars: number; hardMaxChars: number } {
  const requestedMinChars = Math.max(1, Math.floor(params.minChars));
  const requestedMaxChars = Math.max(requestedMinChars, Math.floor(params.maxChars));
  const hardMaxChars = Math.max(1, Math.floor(params.hardMaxChars ?? requestedMaxChars));
  const maxChars = Math.min(requestedMaxChars, hardMaxChars);
  return {
    minChars: Math.min(requestedMinChars, maxChars),
    maxChars,
    hardMaxChars,
  };
}

export function findSafeSentenceBreakIndex(
  text: string,
  fenceSpans: FenceSpan[],
  minChars: number,
  offset = 0,
  openFence?: FenceSpan,
): number {
  const matches = text.matchAll(/[.!?](?=\s|$)/g);
  let sentenceIdx = -1;
  for (const match of matches) {
    const at = match.index ?? -1;
    if (at < minChars) {
      continue;
    }
    const candidate = at + 1;
    if (offset + candidate !== openFence?.end && isSafeFenceBreak(fenceSpans, offset + candidate)) {
      sentenceIdx = candidate;
    }
  }
  return sentenceIdx >= minChars ? sentenceIdx : -1;
}

export function findSafeParagraphBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, minChars, reverse, offset = 0 } = params;
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
      if (isSafeFenceBreak(fenceSpans, offset + candidate)) {
        return candidate;
      }
    }
    paragraphIdx = reverse
      ? text.lastIndexOf("\n\n", paragraphIdx - 1)
      : text.indexOf("\n\n", paragraphIdx + 2);
  }
  return -1;
}

export function findSafeNewlineBreakIndex(params: {
  text: string;
  fenceSpans: FenceSpan[];
  minChars: number;
  reverse: boolean;
  offset?: number;
}): number {
  const { text, fenceSpans, minChars, reverse, offset = 0 } = params;
  let newlineIdx = reverse ? text.lastIndexOf("\n") : text.indexOf("\n");
  while (reverse ? newlineIdx >= minChars : newlineIdx !== -1) {
    if (newlineIdx >= minChars && isSafeFenceBreak(fenceSpans, offset + newlineIdx)) {
      return newlineIdx;
    }
    newlineIdx = reverse
      ? text.lastIndexOf("\n", newlineIdx - 1)
      : text.indexOf("\n", newlineIdx + 1);
  }
  return -1;
}
