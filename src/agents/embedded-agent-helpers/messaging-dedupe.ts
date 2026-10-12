import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_SUBSTRING_DUPLICATE_RATIO = 0.5;

export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A reply tail is new when it still has a letter or digit after every prior send
// is taken out of it. Longest sends go first so a send that contains another
// one is removed whole.
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
      // Text that opens with a prior send and then says something new is a
      // follow-up, not a repeat. The length ratio cannot tell "<sent> All good!"
      // from "<sent> Actually it failed.", so a tail with any letter or digit is
      // delivered. A tail that is only punctuation, or only repeats other sends,
      // still falls through to the ratio.
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
  // One call with every send: a reply that opens with one send is judged
  // against the others too.
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
