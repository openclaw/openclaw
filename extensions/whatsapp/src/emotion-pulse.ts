export type WhatsAppEmotionPulseId =
  | "silent"
  | "react_only"
  | "micro_ack"
  | "work_intake"
  | "hype"
  | "laugh"
  | "warmth"
  | "shock"
  | "skepticism"
  | "win"
  | "correction";

export type WhatsAppEmotionCarrier =
  | "silent"
  | "reaction_only"
  | "micro_text"
  | "caps_burst"
  | "emoji_burst"
  | "task_reply";

export type WhatsAppEmotionPulseDecision = {
  id: WhatsAppEmotionPulseId;
  carrier: WhatsAppEmotionCarrier;
  intensity: 0 | 1 | 2 | 3;
  reason: string;
};

export type WhatsAppEmotionTextShape = {
  emojiCount: number;
  emojiOnly: boolean;
  wordCount: number;
  uppercaseWordCount: number;
  uppercaseWordRatio: number;
  repeatedPunctuation: boolean;
};

const DEFAULT_SELECTED_EMOJIS = [
  "👨🏻‍💻",
  "🫡",
  "💓",
  "🏗️",
  "👷🏻‍♂️",
  "🤣",
  "🥰",
  "🤡",
  "🤯",
  "💀",
  "🔥",
  "🤨",
  "🏆",
  "🥹",
  "💯",
  "😭",
];

const EMOJI_MODIFIER_OR_JOINER_RE =
  /\uFE0F|\u200D|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu;
const GENERIC_EMOJI_RE = /\p{Extended_Pictographic}/gu;

function cleanText(value: string | undefined | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, "")
    .trim();
}

function normalizeEmojiList(value: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of value?.length ? value : DEFAULT_SELECTED_EMOJIS) {
    const emoji = entry.trim();
    if (emoji) {
      seen.add(emoji);
    }
  }
  return Array.from(seen).toSorted((a, b) => b.length - a.length);
}

function countSelectedEmojiOccurrences(value: string, emojis?: readonly string[]) {
  let rest = value;
  let count = 0;
  for (const emoji of normalizeEmojiList(emojis)) {
    const parts = rest.split(emoji);
    if (parts.length <= 1) {
      continue;
    }
    count += parts.length - 1;
    rest = parts.join("");
  }
  return { count, rest };
}

export function analyzeWhatsAppEmotionTextShape(params: {
  text: string;
  allowedEmojis?: readonly string[];
}): WhatsAppEmotionTextShape {
  const text = cleanText(params.text);
  const selected = countSelectedEmojiOccurrences(text, params.allowedEmojis);
  const genericEmojiCount = selected.rest.match(GENERIC_EMOJI_RE)?.length ?? 0;
  const strippedEmoji = selected.rest
    .replace(GENERIC_EMOJI_RE, "")
    .replace(EMOJI_MODIFIER_OR_JOINER_RE, "");
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  const latinWords = text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  const uppercaseWordCount = latinWords.filter(
    (word) => word.length >= 2 && word === word.toUpperCase(),
  ).length;
  return {
    emojiCount: selected.count + genericEmojiCount,
    emojiOnly: selected.count + genericEmojiCount > 0 && !/[\p{L}\p{N}]/u.test(strippedEmoji),
    wordCount: words.length,
    uppercaseWordCount,
    uppercaseWordRatio: latinWords.length > 0 ? uppercaseWordCount / latinWords.length : 0,
    repeatedPunctuation: /[!?]{4,}/u.test(text),
  };
}

function pulse(
  id: WhatsAppEmotionPulseId,
  carrier: WhatsAppEmotionCarrier,
  intensity: 0 | 1 | 2 | 3,
  reason: string,
): WhatsAppEmotionPulseDecision {
  return { id, carrier, intensity, reason };
}

export function classifyWhatsAppEmotionPulse(params: {
  body: string;
  lowSignal?: boolean;
  substantiveTask?: boolean;
  depthRequested?: boolean;
}): WhatsAppEmotionPulseDecision {
  const body = cleanText(params.body);
  if (!body) {
    return pulse("silent", "silent", 0, "empty_body");
  }
  if (params.depthRequested || params.substantiveTask) {
    return pulse("work_intake", "task_reply", 1, "substantive_task_or_depth");
  }

  const shape = analyzeWhatsAppEmotionTextShape({ text: body });
  if (shape.emojiOnly) {
    if (/[💓🥰🥹]/u.test(body)) {
      return pulse(
        "warmth",
        shape.emojiCount >= 5 ? "emoji_burst" : "reaction_only",
        2,
        "warm_emoji_only",
      );
    }
    if (/[🔥💯🏆🤯]/u.test(body)) {
      return pulse(
        "hype",
        shape.emojiCount >= 5 ? "emoji_burst" : "reaction_only",
        2,
        "hype_emoji_only",
      );
    }
    return pulse("laugh", shape.emojiCount >= 5 ? "emoji_burst" : "reaction_only", 2, "emoji_only");
  }

  if (/\b(?:my bad|bad read|fair|you'?re right|i overdid|that'?s on me|deserved)\b/i.test(body)) {
    return pulse("correction", "micro_text", 1, "correction_or_accountability");
  }
  if (/\b(?:lmao+|lmfao+|haha+|lol+|bruh|bro what|insane|wild|cursed|cooked)\b/i.test(body)) {
    return pulse("laugh", params.lowSignal ? "emoji_burst" : "micro_text", 2, "laugh_or_chaos");
  }
  if (/\b(?:wait|what+|no way|no shot|wtf+|holy|my god)\b/i.test(body)) {
    return pulse(
      "shock",
      shape.uppercaseWordCount > 0 ? "caps_burst" : "micro_text",
      2,
      "shock_or_disbelief",
    );
  }
  if (
    /\b(?:fixed|works?|working|landed|shipped|clean|back|we got|got it|root cause)\b/i.test(body)
  ) {
    return pulse("win", "micro_text", 2, "technical_win");
  }
  if (/\b(?:love|proud|sweet|cute|appreciate|thank|good one|happy)\b/i.test(body)) {
    return pulse("warmth", "micro_text", 2, "warmth_or_affection");
  }
  if (/\b(?:nah|be serious|really|sus|hmm|doubt)\b/i.test(body)) {
    return pulse("skepticism", "micro_text", 1, "skepticism");
  }
  if (params.lowSignal) {
    return pulse("micro_ack", "micro_text", 1, "low_signal_micro_ack");
  }
  return pulse("react_only", "reaction_only", 1, "ambient_social_signal");
}

export function resolveWhatsAppEmotionPulseGuidance(params: {
  allowedEmojis?: readonly string[];
  workIntakeEmoji?: string;
}): string[] {
  const selected = normalizeEmojiList(params.allowedEmojis).join(" ");
  const workEmoji = params.workIntakeEmoji?.trim() || "👨🏻‍💻";
  return [
    `WhatsApp Emotion Pulse: after routing says you have the turn, choose one carrier: reaction_only, micro_text, caps_burst, emoji_burst, or task_reply. Emotion never overrides NO_REPLY or lets you join a Brodie/other-person turn.`,
    `Carrier shapes: micro_text is usually 3-7 words; caps_burst is 2-5 caps words with 0-2 selected emojis; emoji_burst is 5-7 selected emojis with no text; task_reply is for real work or explicit depth. In casual group one-liners, do not force a final period.`,
    `Brodie-finesse lesson: make people feel heard without answering every fragment. Prefer a reaction or one tiny line when the beat already landed; do not review someone else's task unless asked.`,
    `Palette anchors from the selected set (${selected}): work intake ${workEmoji}; wins like WE GOT IT or clean 🔥; chaos like 💀💀💀💀💀 or WAIT; warmth like 🥹🥹💓💓🥹; corrections like bad read or fair.`,
  ];
}
