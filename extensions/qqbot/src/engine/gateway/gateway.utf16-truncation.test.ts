import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot tests cover the onMessageSent TTS preview truncation in
// gateway.ts:64. Verifies that `truncateUtf16Safe` drops a surrogate pair
// that straddles the 30-char truncation boundary instead of leaving a lone
// high-surrogate half in the `onMessageSent` info log line.
import { describe, expect, it } from "vitest";

describe("gateway onMessageSent TTS preview UTF-16 truncation", () => {
  const emoji = "🎉";

  it("drops a surrogate pair straddling the 30-char boundary (onMessageSent TTS path)", () => {
    const input = "a".repeat(29) + emoji;
    const out = truncateUtf16Safe(input, 30);
    expect(out.length).toBe(29);
    expect(out).toBe("a".repeat(29));
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("pass-through for plain ASCII (no regression)", () => {
    const input = "hello world";
    expect(truncateUtf16Safe(input, 30)).toBe(input);
  });

  it("emoji fully inside the 30-char window is preserved (no false-positive drops)", () => {
    const input = emoji + "a".repeat(30);
    const out = truncateUtf16Safe(input, 30);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(30);
  });

  it('undefined TTS falls back to empty string (the `meta.ttsText ?? ""` path is surrogate-safe)', () => {
    expect(truncateUtf16Safe(undefined ?? "", 30)).toBe("");
  });
});
