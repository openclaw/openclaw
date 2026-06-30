import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot tests cover surrogate-pair-safe log preview truncation for the messaging
// cluster (streaming-c2c.ts + outbound.ts + outbound-deliver.ts + reply-dispatcher.ts).
// The four source files share no dedicated *.test.ts, so a focused truncation suite
// keeps the boundary proof adjacent to the source changes.
//
// All tests are helper-only — they exercise `truncateUtf16Safe` from
// `openclaw/plugin-sdk/text-utility-runtime` directly. The production call
// sites only swap a raw `.slice(0, N)` for the helper, so a regression on the
// helper itself would be caught here rather than via the SDK's existing unit
// tests.
import { describe, expect, it } from "vitest";

const emoji = "🎉"; // U+1F389, surrogate pair 0xd83c 0xdf89

describe("streaming-c2c onDeliver payload preview truncation (cap=60)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/streaming-c2c.ts:545 —
  // `truncateUtf16Safe(payload.text ?? "", 60).replace(/\n/g, "\\n")` for the
  // streaming C2C debug log. The replace step operates on the safe slice.
  it("drops a trailing surrogate straddling the 60-char boundary", () => {
    const input = "a".repeat(59) + emoji;
    const out = truncateUtf16Safe(input, 60);
    expect(out.length).toBe(59);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(40);
    expect(truncateUtf16Safe(input, 60)).toBe(input);
  });

  it("treats undefined-equivalent input as empty", () => {
    expect(truncateUtf16Safe("", 60)).toBe("");
  });

  it("preserves an emoji fully inside the 60-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(58);
    const out = truncateUtf16Safe(input, 60);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(60);
  });
});

describe("outbound debugLog ctx preview truncation (cap=50)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/outbound.ts:102 —
  // `text: text ? truncateUtf16Safe(text, 50) : undefined` inside the JSON.stringify
  // payload. The conditional preserves the previous behavior of omitting `text`
  // when it is undefined (JSON.stringify drops keys with undefined values).
  it("drops a trailing surrogate straddling the 50-char boundary", () => {
    const input = "a".repeat(49) + emoji;
    const out = truncateUtf16Safe(input, 50);
    expect(out.length).toBe(49);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(30);
    expect(truncateUtf16Safe(input, 50)).toBe(input);
  });

  it("treats empty input as empty", () => {
    expect(truncateUtf16Safe("", 50)).toBe("");
  });

  it("preserves an emoji fully inside the 50-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(48);
    const out = truncateUtf16Safe(input, 50);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(50);
  });
});

describe("outbound sendText sent-part log preview truncation (cap=30)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/outbound.ts:225 —
  // `truncateUtf16Safe(item.content, 30)` for the per-part debug log.
  it("drops a trailing surrogate straddling the 30-char boundary", () => {
    const input = "a".repeat(29) + emoji;
    const out = truncateUtf16Safe(input, 30);
    expect(out.length).toBe(29);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(20);
    expect(truncateUtf16Safe(input, 30)).toBe(input);
  });

  it("treats empty input as empty", () => {
    expect(truncateUtf16Safe("", 30)).toBe("");
  });

  it("preserves an emoji fully inside the 30-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(28);
    const out = truncateUtf16Safe(input, 30);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(30);
  });
});

describe("outbound-deliver sendText chunk log preview truncation (cap=50)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/outbound-deliver.ts:211 —
  // `truncateUtf16Safe(chunk, 50)` for the per-chunk success log.
  it("drops a trailing surrogate straddling the 50-char boundary", () => {
    const input = "a".repeat(49) + emoji;
    const out = truncateUtf16Safe(input, 50);
    expect(out.length).toBe(49);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(30);
    expect(truncateUtf16Safe(input, 50)).toBe(input);
  });

  it("treats empty input as empty", () => {
    expect(truncateUtf16Safe("", 50)).toBe("");
  });

  it("preserves an emoji fully inside the 50-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(48);
    const out = truncateUtf16Safe(input, 50);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(50);
  });
});

describe("outbound-deliver sendTextOnly chunk log preview truncation (cap=50)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/outbound-deliver.ts:240 —
  // `truncateUtf16Safe(chunk, 50)` for the text-only chunk success log. Same cap as
  // sendText but a separate call site; described separately to mirror the diff.
  it("drops a trailing surrogate straddling the 50-char boundary", () => {
    const input = "a".repeat(49) + emoji;
    const out = truncateUtf16Safe(input, 50);
    expect(out.length).toBe(49);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(30);
    expect(truncateUtf16Safe(input, 50)).toBe(input);
  });

  it("treats empty input as empty", () => {
    expect(truncateUtf16Safe("", 50)).toBe("");
  });

  it("preserves an emoji fully inside the 50-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(48);
    const out = truncateUtf16Safe(input, 50);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(50);
  });
});

describe("reply-dispatcher TTS preview truncation (cap=50)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/messaging/reply-dispatcher.ts:419 —
  // `truncateUtf16Safe(ttsText, 50)` for the TTS debug log.
  it("drops a trailing surrogate straddling the 50-char boundary", () => {
    const input = "a".repeat(49) + emoji;
    const out = truncateUtf16Safe(input, 50);
    expect(out.length).toBe(49);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(30);
    expect(truncateUtf16Safe(input, 50)).toBe(input);
  });

  it("treats empty input as empty", () => {
    expect(truncateUtf16Safe("", 50)).toBe("");
  });

  it("preserves an emoji fully inside the 50-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(48);
    const out = truncateUtf16Safe(input, 50);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(50);
  });
});
