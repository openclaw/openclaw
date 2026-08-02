// Telegram renders <pre> table fallbacks in a monospace font where East Asian
// Wide/Fullwidth code points and emoji occupy two cells. String.length counts
// UTF-16 code units, which undercounts CJK (one unit, two cells) and
// miscounts emoji (two units, two cells), so padding by .length misaligns
// every column once a cell contains non-ASCII text.
// Wide ranges mirror the CJK set in packages/ai/src/transports/transport-utils.ts.
const WIDE_CODE_POINT_PATTERN =
  /[\u1100-\u115F\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{2FA1F}]/u;

export function telegramMonospaceWidth(text: string): number {
  let width = 0;
  for (const codePoint of text) {
    width += WIDE_CODE_POINT_PATTERN.test(codePoint) ? 2 : 1;
  }
  return width;
}

export function padEndTelegramMonospace(text: string, targetWidth: number): string {
  const missing = targetWidth - telegramMonospaceWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}
