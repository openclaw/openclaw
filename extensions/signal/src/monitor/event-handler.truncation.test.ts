import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Signal tests cover event handler.truncation plugin behavior.
import { describe, expect, it } from "vitest";

describe("signal inbound preview truncation", () => {
  it("drops an emoji whole when it straddles the 200-char preview boundary", () => {
    // Emoji 😀 (U+1F600) occupies UTF-16 indices 199-200.
    // A raw .slice(0, 200) would keep the high surrogate at index 199 and
    // drop the low surrogate at index 200, leaving a dangling U+D83D.
    const body = `${"a".repeat(199)}\u{1F600}${"b".repeat(50)}`;
    expect(body.length).toBeGreaterThanOrEqual(251);

    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");

    // No lone surrogate halves in the output
    expect(/[\u{D800}-\u{DFFF}]/u.test(preview)).toBe(false);

    // The safe truncation drops both surrogates, yielding 199 ASCII chars
    expect(preview.length).toBe(199);
    expect(preview).toBe("a".repeat(199));
  });

  it("preserves emoji when it fits within the 200-char limit", () => {
    const body = `${"a".repeat(50)}\u{1F600}${"b".repeat(50)}`;
    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");

    expect(/[\u{D800}-\u{DFFF}]/u.test(preview)).toBe(false);
    expect(preview).toBe(body);
  });

  it("truncates long plain ASCII text without modification", () => {
    const body = "x".repeat(500);
    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");

    expect(preview.length).toBe(200);
    expect(preview).toBe("x".repeat(200));
  });

  it("handles boundary at position 0", () => {
    const body = "\u{1F600}" + "a".repeat(50);
    const preview = truncateUtf16Safe(body, 1).replace(/\n/g, "\\n");
    // The emoji takes 2 code units, so truncating at 1 drops it
    expect(preview.length).toBe(0);
    expect(/[\u{D800}-\u{DFFF}]/u.test(preview)).toBe(false);
  });

  it("handles body already shorter than limit", () => {
    const body = "hello";
    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
    expect(preview).toBe("hello");
  });
});
