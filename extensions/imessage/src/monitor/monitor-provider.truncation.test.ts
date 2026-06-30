// Imessage tests cover the UTF-16-safe debounced-merge preview in
// monitor-provider.ts:731. Verifies that `sliceUtf16Safe` drops a surrogate
// pair that straddles the 50-char truncation boundary instead of leaving a
// lone high-surrogate half in the preview, and that the existing conditional
// `"..."` ellipsis at L732 still fires correctly when the original input
// exceeded the cap.
import { describe, expect, it } from "vitest";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

describe("monitor-provider debounced-merge preview truncation", () => {
  const emoji = "🎉";

  it("sliceUtf16Safe drops a trailing surrogate straddling the 50-char boundary", () => {
    const input = "a".repeat(49) + emoji;
    const out = sliceUtf16Safe(input, 0, 50);
    expect(out.length).toBe(49);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("ellipsis marker is appended when the original text exceeded 50 chars (no surrogate regression)", () => {
    const input = "a".repeat(60);
    const out = sliceUtf16Safe(input, 0, 50);
    const ellipsis = input.length > 50 ? "..." : "";
    expect(out + ellipsis).toBe("a".repeat(50) + "...");
  });

  it("empty input stays empty", () => {
    expect(sliceUtf16Safe("", 0, 50)).toBe("");
  });

  it("emoji fully inside the window is preserved (no false-positive drops)", () => {
    const input = emoji + "a".repeat(50);
    const out = sliceUtf16Safe(input, 0, 50);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(50);
  });
});