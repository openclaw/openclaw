import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_SUBSTRING_DUPLICATE_RATIO = 0.5;

export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Remove longer sends first so overlapping prior messages still count as repeats.
function hasTextBeyondSentTexts(tail: string, normalizedSentTexts: string[]): boolean {
  let remainder = tail;
  for (const normalizedSent of normalizedSentTexts.toSorted((a, b) => b.length - a.length)) {
    if (normalizedSent.length >= MIN_DUPLICATE_TEXT_LENGTH) {
      remainder = remainder.replaceAll(normalizedSent, " ");
    }
  }
  return /[\p{L}\p{N}]/u.test(remainder);
}

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
      // A sent prefix must not hide a correction; punctuation and repeated sends add no new text.
      if (
        normalized.startsWith(normalizedSent) &&
        hasTextBeyondSentTexts(normalized.slice(normalizedSent.length), normalizedSentTexts)
      ) {
        return false;
      }
      return normalizedSent.length >= normalized.length * MIN_SUBSTRING_DUPLICATE_RATIO;
    }
    return (
      normalizedSent.includes(normalized) &&
      normalized.length >= normalizedSent.length * MIN_SUBSTRING_DUPLICATE_RATIO
    );
  });
}

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
  // A confirmed current-source tool send already made this prefix visible.
  // Hold it until the assistant either repeats the sent text or diverges with new content.
  const hold =
    Boolean(normalized) &&
    state.currentSourceMessagingToolSentTextsNormalized.some(
      (sentText) => sentText === normalized || sentText.startsWith(normalized),
    );
  state.currentSourceMessagingToolHeldPartial = hold ? text : undefined;
  return { hold, text };
}
