import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { isOversizedForSummary, MAX_SUMMARISABLE_CONTENT_CHARS } from "./compaction.js";

/**
 * Tests for the character-based fallback in isOversizedForSummary (#3479).
 *
 * Token-based detection can underestimate certain payloads (minified JSON,
 * base64, dense text).  The character fallback ensures these are still
 * excluded from summarisation chunks so compaction does not fail.
 */
describe("isOversizedForSummary – character-based fallback", () => {
  // Use a large context window so the *token* check alone would NOT trigger.
  const largeContextWindow = 1_000_000;

  it("exports the MAX_SUMMARISABLE_CONTENT_CHARS constant", () => {
    expect(MAX_SUMMARISABLE_CONTENT_CHARS).toBe(100_000);
  });

  it("flags a message with string content exceeding the char limit", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(MAX_SUMMARISABLE_CONTENT_CHARS + 1),
      timestamp: 0,
    };
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(true);
  });

  it("does not flag a message with string content within the char limit", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(1000),
      timestamp: 0,
    };
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(false);
  });

  it("flags a tool result with array content exceeding the char limit", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "z".repeat(MAX_SUMMARISABLE_CONTENT_CHARS + 100) }],
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(true);
  });

  it("sums text across multiple content blocks", () => {
    const half = Math.ceil(MAX_SUMMARISABLE_CONTENT_CHARS / 2) + 1;
    const msg = {
      role: "toolResult",
      toolCallId: "c1",
      content: [
        { type: "text", text: "a".repeat(half) },
        { type: "text", text: "b".repeat(half) },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(true);
  });

  it("ignores non-text blocks when measuring chars", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "c1",
      content: [
        { type: "image", source: "data:..." + "x".repeat(200_000) }, // big but not text
        { type: "text", text: "small" },
      ],
      timestamp: 0,
    } as unknown as AgentMessage;
    // Only the text block counts, which is small
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(false);
  });

  it("handles messages with no content", () => {
    const msg = {
      role: "user",
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(false);
  });

  it("handles messages with empty array content", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "c1",
      content: [],
      timestamp: 0,
    } as unknown as AgentMessage;
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(false);
  });

  it("still flags by tokens even when chars are within limit", () => {
    // A small-context window (1000 tokens) with a modest message should
    // trigger the token-based check even if chars are well under 100K.
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(4000), // ~1000 tokens
      timestamp: 0,
    };
    // With contextWindow=1000, 50% threshold=500 tokens.
    // SAFETY_MARGIN=1.2, so message ~1000*1.2=1200 > 500 → oversized.
    expect(isOversizedForSummary(msg, 1000)).toBe(true);
  });

  it("does not flag at exactly the char limit", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(MAX_SUMMARISABLE_CONTENT_CHARS),
      timestamp: 0,
    };
    // Exactly at the limit — should NOT flag (> not >=)
    expect(isOversizedForSummary(msg, largeContextWindow)).toBe(false);
  });
});
