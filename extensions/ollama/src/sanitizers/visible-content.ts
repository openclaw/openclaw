import {
  createKimiInlineReasoningSanitizer,
  isOllamaCloudKimiModelRef,
} from "./kimi-inline-reasoning.js";
import type { OllamaVisibleContentSanitizer } from "./visible-content-contract.js";

const noopVisibleContentSanitizer: OllamaVisibleContentSanitizer = {
  resolveStreamText(params) {
    return { kind: "visible", text: params.text };
  },
  sanitizeFinalText(text) {
    return text;
  },
};

export function createOllamaVisibleContentSanitizer(
  modelId: string,
): OllamaVisibleContentSanitizer {
  if (isOllamaCloudKimiModelRef(modelId)) {
    return createKimiInlineReasoningSanitizer();
  }
  return noopVisibleContentSanitizer;
}

export function sanitizeOllamaFinalVisibleContent(params: {
  modelId: string;
  text: string;
}): string {
  return createOllamaVisibleContentSanitizer(params.modelId).sanitizeFinalText(params.text);
}

const GARBLED_VISIBLE_TEXT_MODEL_RE = /\b(?:glm|kimi)\b/i;
const GARBLED_VISIBLE_TEXT_MIN_CHARS = 80;
const GARBLED_VISIBLE_TEXT_SYMBOL_RE = /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]/gu;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/gu;

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re)).length;
}

function maxCharacterFrequency(text: string): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const char of text) {
    const count = (counts.get(char) ?? 0) + 1;
    counts.set(char, count);
    max = Math.max(max, count);
  }
  return max;
}

export function isLikelyGarbledVisibleText(params: { text: string; modelId: string }): boolean {
  if (!GARBLED_VISIBLE_TEXT_MODEL_RE.test(params.modelId)) {
    return false;
  }
  const compact = params.text.replace(/\s+/g, "");
  if (compact.length < GARBLED_VISIBLE_TEXT_MIN_CHARS) {
    return false;
  }

  const letterOrDigitCount = countMatches(compact, LETTER_OR_DIGIT_RE);
  const symbolCount = countMatches(compact, GARBLED_VISIBLE_TEXT_SYMBOL_RE);
  const maxFrequency = maxCharacterFrequency(compact);
  const letterOrDigitRatio = letterOrDigitCount / compact.length;
  const symbolRatio = symbolCount / compact.length;
  const dominantCharacterRatio = maxFrequency / compact.length;

  return (
    letterOrDigitRatio < 0.08 &&
    symbolRatio > 0.6 &&
    (dominantCharacterRatio > 0.22 || /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]{12,}/u.test(compact))
  );
}
