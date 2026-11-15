const emojiSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
// Flags, keycaps, subdivision flags, and pictographic ZWJ sequences with modifiers.
const emojiSequence =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)$/u;

/** One emoji grapheme: the Gateway's admission rule, shared with pickers for instant feedback. */
export function isReactionEmoji(emoji: string): boolean {
  return (
    Array.from(emoji).length <= 32 &&
    [...emojiSegmenter.segment(emoji)].length === 1 &&
    emojiSequence.test(emoji)
  );
}
