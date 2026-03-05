import { describe, expect, it } from "vitest";
import {
  estimateMessageCharsCached,
  createMessageCharEstimateCache,
  getToolResultText,
} from "./tool-result-char-estimator.js";

describe("tool-result-char-estimator", () => {
  describe("malformed text blocks", () => {
    it("does not crash on {type:'text'} with no text property", () => {
      const cache = createMessageCharEstimateCache();
      const msg = {
        role: "toolResult" as const,
        toolCallId: "call_1",
        toolName: "test",
        content: [{ type: "text" }],
        isError: false,
      };
      // Should not throw — previously crashed with
      // "Cannot read properties of undefined (reading 'length')"
      const chars = estimateMessageCharsCached(msg as never, cache);
      expect(chars).toBeGreaterThanOrEqual(0);
    });

    it("getToolResultText skips blocks with missing text property", () => {
      const msg = {
        role: "toolResult" as const,
        toolCallId: "call_1",
        toolName: "test",
        content: [{ type: "text" }, { type: "text", text: "hello" }],
        isError: false,
      };
      const text = getToolResultText(msg as never);
      expect(text).toBe("hello");
    });
  });
});
