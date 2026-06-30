import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot tests cover the onDeliver preview truncation in
// streaming-c2c.ts:546. Verifies that `truncateUtf16Safe` drops a surrogate
// pair that straddles the 60-char truncation boundary instead of leaving a
// lone high-surrogate half in the `onDeliver` debug log line.
import { describe, expect, it } from "vitest";

describe("streaming-c2c onDeliver preview UTF-16 truncation", () => {
  const emoji = "🎉";

  it("drops a surrogate pair straddling the 60-char boundary (onDeliver preview path)", () => {
    const input = "a".repeat(59) + emoji;
    const out = truncateUtf16Safe(input, 60);
    expect(out.length).toBe(59);
    expect(out).toBe("a".repeat(59));
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("pass-through for plain ASCII (no regression)", () => {
    const input = "hello world";
    expect(truncateUtf16Safe(input, 60)).toBe(input);
  });

  it("emoji fully inside the 60-char window is preserved (no false-positive drops)", () => {
    const input = emoji + "a".repeat(60);
    const out = truncateUtf16Safe(input, 60);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(60);
  });

  it('empty text stays empty (the `payload.text ?? ""` fallback is surrogate-safe)', () => {
    expect(truncateUtf16Safe("", 60)).toBe("");
  });
});
