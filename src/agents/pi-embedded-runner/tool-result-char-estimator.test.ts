import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
} from "./tool-result-char-estimator.js";

function makeToolResult(content: unknown): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "sentinel_control",
    content,
    isError: false,
    timestamp: Date.now(),
  });
}

describe("estimateMessageChars", () => {
  describe("malformed text blocks", () => {
    it("does not crash on {type:'text'} with no text property", () => {
      // #given — exact malformed content from the sentinel_control remove bug
      const msg = makeToolResult([{ type: "text" }]);

      // #when
      const cache = createMessageCharEstimateCache();
      const chars = estimateMessageCharsCached(msg, cache);

      // #then — should not throw, and should return a non-negative value
      expect(chars).toBeGreaterThanOrEqual(0);
    });

    it("does not crash on {type:'text', text: undefined}", () => {
      const msg = makeToolResult([{ type: "text", text: undefined }]);
      const cache = createMessageCharEstimateCache();

      expect(() => estimateMessageCharsCached(msg, cache)).not.toThrow();
    });

    it("does not crash on {type:'text', text: null}", () => {
      const msg = makeToolResult([{ type: "text", text: null }]);
      const cache = createMessageCharEstimateCache();

      expect(() => estimateMessageCharsCached(msg, cache)).not.toThrow();
    });

    it("does not crash on {type:'text', text: 42}", () => {
      const msg = makeToolResult([{ type: "text", text: 42 }]);
      const cache = createMessageCharEstimateCache();

      expect(() => estimateMessageCharsCached(msg, cache)).not.toThrow();
    });

    it("treats malformed text block as unknown content with non-zero estimate", () => {
      const msg = makeToolResult([{ type: "text" }]);
      const cache = createMessageCharEstimateCache();
      const chars = estimateMessageCharsCached(msg, cache);

      // Falls through to estimateUnknownChars which serializes the block as JSON
      expect(chars).toBeGreaterThan(0);
    });

    it("still estimates valid text blocks correctly", () => {
      const msg = makeToolResult([{ type: "text", text: "hello" }]);
      const cache = createMessageCharEstimateCache();
      const chars = estimateMessageCharsCached(msg, cache);

      // 5 chars * (4/2) weight = 10
      expect(chars).toBeGreaterThanOrEqual(5);
    });

    it("handles mixed valid and malformed text blocks", () => {
      const msg = makeToolResult([
        { type: "text", text: "valid" },
        { type: "text" },
        { type: "text", text: "also valid" },
      ]);
      const cache = createMessageCharEstimateCache();

      expect(() => estimateMessageCharsCached(msg, cache)).not.toThrow();
      expect(estimateMessageCharsCached(msg, cache)).toBeGreaterThan(0);
    });
  });

  describe("estimateContextChars with malformed content", () => {
    it("does not crash when messages contain malformed tool results", () => {
      // #given — simulate a conversation with a malformed tool result
      const messages: AgentMessage[] = [
        castAgentMessage({
          role: "user",
          content: "remove watcher timeapi-test-2361",
          timestamp: Date.now(),
        }),
        castAgentMessage({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_remove",
              name: "sentinel_control",
              arguments: { action: "remove", id: "timeapi-test-2361" },
            },
          ],
        }),
        makeToolResult([{ type: "text" }]),
      ];
      const cache = createMessageCharEstimateCache();

      // #when / #then — should not throw
      expect(() => estimateContextChars(messages, cache)).not.toThrow();
    });
  });
});

describe("getToolResultText", () => {
  it("skips malformed text blocks with no text property", () => {
    const msg = makeToolResult([{ type: "text" }, { type: "text", text: "valid" }]);

    expect(getToolResultText(msg)).toBe("valid");
  });

  it("returns empty string when only malformed text blocks exist", () => {
    const msg = makeToolResult([{ type: "text" }]);

    expect(getToolResultText(msg)).toBe("");
  });
});
