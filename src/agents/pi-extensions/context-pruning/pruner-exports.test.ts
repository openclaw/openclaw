import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN_ESTIMATE, estimateContextChars } from "./pruner.js";

describe("pruner exports", () => {
  describe("CHARS_PER_TOKEN_ESTIMATE", () => {
    it("is exported and equals 4", () => {
      expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
    });

    it("is a positive integer", () => {
      expect(Number.isInteger(CHARS_PER_TOKEN_ESTIMATE)).toBe(true);
      expect(CHARS_PER_TOKEN_ESTIMATE).toBeGreaterThan(0);
    });
  });

  describe("estimateContextChars", () => {
    it("is exported as a function", () => {
      expect(typeof estimateContextChars).toBe("function");
    });

    it("returns 0 for empty messages array", () => {
      expect(estimateContextChars([])).toBe(0);
    });

    it("estimates character count for user string messages", () => {
      const messages = [{ role: "user" as const, content: "hello world" }];
      expect(estimateContextChars(messages as any)).toBe(11);
    });

    it("estimates character count for multiple messages", () => {
      const messages = [
        { role: "user" as const, content: "hello" },
        { role: "user" as const, content: "world" },
      ];
      expect(estimateContextChars(messages as any)).toBe(10);
    });

    it("estimates assistant text content blocks", () => {
      const messages = [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "response text here" }],
        },
      ];
      expect(estimateContextChars(messages as any)).toBe(18);
    });

    it("token estimate from chars is consistent with CHARS_PER_TOKEN_ESTIMATE", () => {
      const messages = [{ role: "user" as const, content: "x".repeat(4000) }];
      const chars = estimateContextChars(messages as any);
      const tokens = Math.round(chars / CHARS_PER_TOKEN_ESTIMATE);
      expect(tokens).toBe(1000);
    });

    it("handles mixed message roles", () => {
      const messages = [
        { role: "user" as const, content: "question" },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "answer" }],
        },
        {
          role: "toolResult" as const,
          toolName: "search",
          toolCallId: "tc1",
          content: [{ type: "text" as const, text: "result data" }],
        },
      ];
      const chars = estimateContextChars(messages as any);
      // "question" = 8, "answer" = 6, "result data" = 11
      expect(chars).toBe(25);
    });
  });
});
