import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Qqbot tests cover surrogate-pair-safe log preview truncation for the gateway
// cluster (gateway.ts + stages/quote-stage.ts). The two source files share no
// dedicated *.test.ts, so a focused truncation suite keeps the boundary proof
// adjacent to the sibling message-queue and inbound-attachments appends.
//
// All tests are helper-only — they exercise `truncateUtf16Safe` from
// `openclaw/plugin-sdk/text-utility-runtime` directly. The production call
// sites (gateway.ts:64 and stages/quote-stage.ts:92) only swap a raw
// `.slice(0, N)` for the helper, so a regression on the helper itself would
// be caught here rather than via the SDK's existing unit tests.
import { describe, expect, it } from "vitest";

const emoji = "🎉"; // U+1F389, surrogate pair 0xd83c 0xdf89

describe("gateway onMessageSent ttsText log preview truncation (cap=30)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/gateway/gateway.ts:64 —
  // `truncateUtf16Safe(meta.ttsText ?? "", 30)` for the onMessageSent debug log.
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

  it("treats empty / undefined-equivalent input as empty", () => {
    expect(truncateUtf16Safe("", 30)).toBe("");
  });

  it("preserves an emoji fully inside the 30-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(28);
    const out = truncateUtf16Safe(input, 30);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(30);
  });
});

describe("quote-stage refBody log preview truncation (cap=80)", () => {
  // Mirrors the call at extensions/qqbot/src/engine/gateway/stages/quote-stage.ts:92 —
  // `truncateUtf16Safe(refBody ?? "", 80)` for the quote-detected debug log.
  it("drops a trailing surrogate straddling the 80-char boundary", () => {
    const input = "a".repeat(79) + emoji;
    const out = truncateUtf16Safe(input, 80);
    expect(out.length).toBe(79);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("passes plain ASCII under the cap through unchanged", () => {
    const input = "x".repeat(60);
    expect(truncateUtf16Safe(input, 80)).toBe(input);
  });

  it("treats empty / undefined-equivalent input as empty", () => {
    expect(truncateUtf16Safe("", 80)).toBe("");
  });

  it("preserves an emoji fully inside the 80-char window (no false-positive drop)", () => {
    const input = emoji + "a".repeat(78);
    const out = truncateUtf16Safe(input, 80);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(80);
  });
});
