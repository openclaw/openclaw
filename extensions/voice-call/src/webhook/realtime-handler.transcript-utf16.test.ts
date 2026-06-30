// Voice-call tests cover the UTF-16-safe partial-transcript tail slice in
// webhook/realtime-handler.ts (limitPartialUserTranscript). Verifies that
// `sliceUtf16Safe(text, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS)` drops a surrogate
// pair that straddles the tail boundary instead of leaving a lone high-
// surrogate half in the partial transcript fed to the agent.
import { describe, expect, it } from "vitest";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

describe("voice-call partial-transcript tail UTF-16", () => {
  // Mirrors MAX_PARTIAL_USER_TRANSCRIPT_CHARS in realtime-handler.ts. The
  // exact cap is not exposed publicly, but the UTF-16-safe slicing contract
  // is the same regardless of the numeric value, so we mirror a representative
  // small cap here.
  const MAX_PARTIAL_USER_TRANSCRIPT_CHARS = 200;
  const emoji = "🎉";

  it("sliceUtf16Safe drops a surrogate pair straddling the tail-start boundary", () => {
    // Build a string of length 301 where the emoji sits at positions
    // (100, 101). With sliceUtf16Safe(input, -200), `from = 301 - 200 = 101`,
    // which is the low surrogate of the emoji, and position 100 is the high
    // surrogate. The helper increments `from` past the high surrogate so the
    // tail does not start with a lone surrogate half.
    const input = "a".repeat(100) + emoji + "a".repeat(199);
    const tail = sliceUtf16Safe(input, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
    // Tail was supposed to be 200 code units, but the dangling high surrogate
    // at position 100 is dropped, so the tail is 199 code units.
    expect(tail.length).toBe(199);
    expect(tail.charCodeAt(0)).toBeLessThan(0xd800);
  });

  it("sliceUtf16Safe is a pass-through for plain ASCII partial transcript", () => {
    const input = "hello world, this is a normal transcript";
    expect(sliceUtf16Safe(input, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS)).toBe(input);
  });

  it("sliceUtf16Safe preserves an emoji that sits entirely inside the tail window", () => {
    // Input is exactly 200 chars. The emoji at position 100 is fully inside
    // the tail window (no surrogate straddles the boundary).
    const input = "a".repeat(100) + emoji + "a".repeat(98);
    const tail = sliceUtf16Safe(input, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
    expect(tail.length).toBe(200);
    expect(tail.includes(emoji)).toBe(true);
  });

  it("limitPartialUserTranscript-shaped behavior: short body passes through", () => {
    // Mirror the production guard at the top of limitPartialUserTranscript:
    // when text.length <= MAX_PARTIAL_USER_TRANSCRIPT_CHARS, the helper is
    // not called (the production guard short-circuits first), so sliceUtf16Safe
    // here is verifying a no-op for short input.
    const input = "short";
    expect(sliceUtf16Safe(input, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS)).toBe(input);
  });
});