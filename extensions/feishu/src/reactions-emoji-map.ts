/**
 * Pure Feishu emoji_type mapping. No runtime/client imports — safe to load
 * from the channel module at module evaluation time without pulling in
 * `client.ts` (which mutates the Lark SDK HTTP interceptor on import).
 *
 * The values below are the documented emoji_type strings from Feishu's
 * official table. The table is case-sensitive: some values are ALL_CAPS
 * (e.g. `THUMBSUP`, `HEART`) while others are PascalCase (e.g. `Fire`,
 * `ThumbsDown`, `CheckMark`, `CrossMark`, `Typing`). Normalization must
 * preserve the documented case; sending `FIRE` or `THUMBSDOWN` produces
 * Feishu API error 231001 ("reaction type is invalid").
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */

/**
 * Common documented Feishu emoji_type values. Exposed as a typed const for
 * call-site convenience; the full canonical table on Feishu's side is larger
 * and continues to grow, so unknown values are passed through to the API
 * unchanged for clear server-side error reporting.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
export const FeishuEmoji = {
  // ALL_CAPS group (documented case)
  THUMBSUP: "THUMBSUP",
  HEART: "HEART",
  SMILE: "SMILE",
  BLUSH: "BLUSH",
  LAUGH: "LAUGH",
  CRY: "CRY",
  ANGRY: "ANGRY",
  SHOCKED: "SHOCKED",
  WOW: "WOW",
  THINKING: "THINKING",
  CLAP: "CLAP",
  OK: "OK",
  FISTBUMP: "FISTBUMP",
  PARTY: "PARTY",
  // PascalCase group (documented case — DO NOT uppercase)
  ThumbsDown: "ThumbsDown",
  Fire: "Fire",
  CheckMark: "CheckMark",
  CrossMark: "CrossMark",
  Typing: "Typing",
} as const;

export type FeishuEmojiType = (typeof FeishuEmoji)[keyof typeof FeishuEmoji];

/**
 * Documented emoji_type values grouped by case-folded key. The key is the
 * uppercased form so case-insensitive user input can be normalized back to
 * the exact documented case (e.g. `fire`, `Fire`, `FIRE` all map to `Fire`).
 *
 * The table covers the common subset surfaced through the channel `react`
 * action. The Feishu API table is larger; unknown inputs are returned
 * unchanged so server-side errors stay clear.
 */
const KNOWN_FEISHU_EMOJI_TYPES: readonly string[] = [
  "THUMBSUP",
  "HEART",
  "SMILE",
  "BLUSH",
  "LAUGH",
  "CRY",
  "ANGRY",
  "SHOCKED",
  "WOW",
  "THINKING",
  "CLAP",
  "OK",
  "FISTBUMP",
  "PARTY",
  "ThumbsDown",
  "Fire",
  "CheckMark",
  "CrossMark",
  "Typing",
];

const feishuEmojiLookupByUpper = new Map<string, string>(
  KNOWN_FEISHU_EMOJI_TYPES.map((value) => [value.toUpperCase(), value]),
);

const feishuEmojiKnownExactly = new Set<string>(KNOWN_FEISHU_EMOJI_TYPES);

/**
 * Map common unicode emojis to documented Feishu emoji_type strings.
 *
 * The Feishu reactions API requires emoji_type values like `THUMBSUP` or
 * `Fire`, not raw unicode characters. When the agent sends a unicode emoji
 * we convert it here so the API call succeeds.
 *
 * Values on the right side MUST match the documented case in the Feishu
 * table — see {@link KNOWN_FEISHU_EMOJI_TYPES}.
 */
const unicodeToFeishuEmoji: Record<string, string> = {
  "\u{1F44D}": "THUMBSUP", // 👍
  "\u{1F44E}": "ThumbsDown", // 👎
  "\u{2764}\u{FE0F}": "HEART", // ❤️
  "\u{2764}": "HEART", // ❤
  "\u{1F60A}": "SMILE", // 😊
  "\u{1F600}": "SMILE", // 😀
  "\u{1F604}": "LAUGH", // 😄
  "\u{1F602}": "LAUGH", // 😂
  "\u{1F622}": "CRY", // 😢
  "\u{1F62D}": "CRY", // 😭
  "\u{1F620}": "ANGRY", // 😠
  "\u{1F621}": "ANGRY", // 😡
  "\u{1F62E}": "SHOCKED", // 😮
  "\u{1F632}": "SHOCKED", // 😲
  "\u{1F914}": "THINKING", // 🤔
  "\u{1F44F}": "CLAP", // 👏
  "\u{1F44C}": "OK", // 👌
  "\u{1F44A}": "FISTBUMP", // 👊
  "\u{270A}": "FISTBUMP", // ✊
  "\u{1F525}": "Fire", // 🔥
  "\u{1F389}": "PARTY", // 🎉
  "\u{1F973}": "PARTY", // 🥳
  "\u{2705}": "CheckMark", // ✅
  "\u{2714}\u{FE0F}": "CheckMark", // ✔️
  "\u{2714}": "CheckMark", // ✔
  "\u{274C}": "CrossMark", // ❌
};

/**
 * Normalize an emoji value to a documented Feishu emoji_type string.
 *
 * Accepts either a documented Feishu emoji_type (`THUMBSUP`, `Fire`,
 * `ThumbsDown`, ...) or a unicode emoji (`👍`, `🔥`, ...) and returns the
 * value the Feishu reactions API expects. Case-insensitive matches on
 * known types are normalized back to the documented case, so callers can
 * write `fire` or `FIRE` and still produce the API-accepted `Fire`.
 * Unknown values are returned unchanged so the server can surface a
 * clear `code: 231001` error.
 */
export function normalizeFeishuEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (feishuEmojiKnownExactly.has(trimmed)) {
    return trimmed;
  }
  const documentedByCase = feishuEmojiLookupByUpper.get(trimmed.toUpperCase());
  if (documentedByCase !== undefined) {
    return documentedByCase;
  }
  return unicodeToFeishuEmoji[trimmed] ?? trimmed;
}
