import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  estimateContextChars,
  estimateMessageCharsCached,
  createMessageCharEstimateCache,
  IMAGE_CHAR_ESTIMATE,
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
} from "./tool-result-char-estimator.js";

function makeToolResultMessage(content: unknown[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "tts",
    content,
    isError: false,
    timestamp: 1,
  };
}

describe("estimateMessageChars", () => {
  it("estimates text blocks at their string length", () => {
    const msg = makeToolResultMessage([{ type: "text", text: "hello world" }]);
    const cache = createMessageCharEstimateCache();
    // Tool-result weighting is applied: Math.ceil(11 * 2) = 22
    const weighting = CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
    expect(estimateMessageCharsCached(msg, cache)).toBe(Math.ceil(11 * weighting));
  });

  it("estimates image blocks at IMAGE_CHAR_ESTIMATE", () => {
    const msg = makeToolResultMessage([
      { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
    ]);
    const cache = createMessageCharEstimateCache();
    // Tool-result weighting factor
    const weighting = CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
    expect(estimateMessageCharsCached(msg, cache)).toBe(Math.ceil(IMAGE_CHAR_ESTIMATE * weighting));
  });

  it("estimates audio blocks at IMAGE_CHAR_ESTIMATE instead of blob length", () => {
    // Simulate a TTS audio block with a large base64 blob
    const largeBase64 = "A".repeat(500_000); // 500 KB of base64 data
    const audioBlock = {
      type: "audio",
      source: { type: "base64", media_type: "audio/mpeg", data: largeBase64 },
    };
    const msg = makeToolResultMessage([audioBlock]);
    const cache = createMessageCharEstimateCache();

    // Without the fix, estimateUnknownChars would serialize the base64 blob → ~500K chars
    // With the fix, audio blocks are estimated at IMAGE_CHAR_ESTIMATE (8,000)
    // Tool-result weighting (2x) is applied on top: ceil(8000 * 2) = 16000
    const weightedEstimate = Math.ceil(IMAGE_CHAR_ESTIMATE * 2);
    expect(estimateMessageCharsCached(msg, cache)).toBe(weightedEstimate);
  });

  it("does not inflate with multiple audio blocks", () => {
    const largeBase64 = "B".repeat(500_000);
    const audioBlock = (n: number) => ({
      type: "audio",
      source: { type: "base64", media_type: "audio/mpeg", data: `${largeBase64}${n}` },
    });

    // 22 audio messages like in the reported issue
    const messages: AgentMessage[] = Array.from({ length: 22 }, (_, i) =>
      makeToolResultMessage([audioBlock(i)]),
    );

    const cache = createMessageCharEstimateCache();
    const totalChars = estimateContextChars(messages, cache);

    // Without the fix: 22 * 500K+ ≈ 11M+ chars (~2.75M tokens)
    // With the fix: 22 * IMAGE_CHAR_ESTIMATE * 2 (tool-result weighting) = 352,000
    const weightedEstimate = 22 * Math.ceil(IMAGE_CHAR_ESTIMATE * 2);
    expect(totalChars).toBe(weightedEstimate);
  });
});
