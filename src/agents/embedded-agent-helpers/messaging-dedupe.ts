/**
 * Normalizes outbound message text to suppress duplicate send actions.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_SUBSTRING_DUPLICATE_RATIO = 0.5;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compare already-normalized message text against prior sends. */
export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) {
    return false;
  }
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) {
      return false;
    }
    if (normalized.includes(normalizedSent)) {
      return normalizedSent.length >= normalized.length * MIN_SUBSTRING_DUPLICATE_RATIO;
    }
    return (
      normalizedSent.includes(normalized) &&
      normalized.length >= normalizedSent.length * MIN_SUBSTRING_DUPLICATE_RATIO
    );
  });
}

/** Return true when raw message text duplicates a prior sent message. */
export function isMessagingToolDuplicate(text: string, sentTexts: string[]): boolean {
  if (sentTexts.length === 0) {
    return false;
  }
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}

export function resolveCurrentSourceMessagingToolPartial(
  state: {
    currentSourceMessagingToolHeldPartial?: string;
    currentSourceMessagingToolSentTextsNormalized: string[];
  },
  params: {
    evtType: "text_delta" | "text_start" | "text_end";
    text: string;
    visibleDelta: string;
  },
): { hold: boolean; text: string } {
  const held = state.currentSourceMessagingToolHeldPartial;
  const text =
    held && params.evtType === "text_delta" && !params.text.startsWith(held)
      ? `${held}${params.visibleDelta || params.text}`
      : params.text;
  const normalized = state.currentSourceMessagingToolSentTextsNormalized.length
    ? normalizeTextForComparison(text)
    : "";
  if (!normalized) {
    state.currentSourceMessagingToolHeldPartial = undefined;
    return { hold: false, text };
  }
  // A confirmed current-source tool send already made this prefix visible.
  // Hold it until the assistant either repeats the sent text or diverges with new content.
  const hold = state.currentSourceMessagingToolSentTextsNormalized.some(
    (sentText) => sentText === normalized || sentText.startsWith(normalized),
  );
  state.currentSourceMessagingToolHeldPartial = hold ? text : undefined;
  return { hold, text };
}
