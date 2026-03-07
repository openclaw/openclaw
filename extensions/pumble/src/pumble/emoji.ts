/**
 * Map Unicode emoji to Pumble shortcode names.
 * Pumble's reaction API uses `:name:` codes, not Unicode codepoints.
 */
const UNICODE_TO_PUMBLE_SHORTCODE: Record<string, string> = {
  "\u{1F440}": "eyes", // 👀
  "\u{1F44D}": "thumbsup", // 👍
  "\u{1F44E}": "thumbsdown", // 👎
  "\u2764\uFE0F": "heart", // ❤️
  "\u2764": "heart", // ❤ (no variant selector)
  "\u{1F525}": "fire", // 🔥
  "\u{1F389}": "tada", // 🎉
  "\u2705": "white_check_mark", // ✅
  "\u274C": "x", // ❌
  "\u{1F914}": "thinking_face", // 🤔
  "\u{1F6E0}\uFE0F": "hammer_and_wrench", // 🛠️
  "\u{1F6E0}": "hammer_and_wrench", // 🛠 (no variant selector)
  "\u{1F4BB}": "computer", // 💻
  "\u{1F310}": "globe_with_meridians", // 🌐
  "\u{1F631}": "scream", // 😱
  "\u{1F971}": "yawning_face", // 🥱
  "\u{1F628}": "fearful", // 😨
  "\u23F3": "hourglass_flowing_sand", // ⏳
  "\u26A0\uFE0F": "warning", // ⚠️
  "\u26A0": "warning", // ⚠ (no variant selector)
  "\u{1F468}\u200D\u{1F4BB}": "man_technologist", // 👨‍💻
  "\u26A1": "zap", // ⚡
};

/** Convert a Unicode emoji (or shortcode) to a Pumble shortcode name. */
export function toPumbleShortcode(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed) {
    return "eyes";
  }
  // Already a shortcode (e.g. "eyes" or ":eyes:")
  if (/^:?\w[\w+-]*:?$/.test(trimmed)) {
    return trimmed.replace(/^:/, "").replace(/:$/, "");
  }
  const mapped = UNICODE_TO_PUMBLE_SHORTCODE[trimmed];
  if (!mapped) {
    // Unknown Unicode emoji — pass through the raw string rather than
    // silently replacing with "eyes". Pumble may reject it, but the
    // caller gets transparent behavior.
    return trimmed;
  }
  return mapped;
}
