import { describe, expect, it } from "vitest";
import type { Message } from "../../../../llm-core/src/index.js";
import { serializeConversation, truncateForSummary } from "./utils.js";

describe("serializeConversation", () => {
  it.each([
    {
      name: "Codex nested toolResult text",
      block: {
        type: "toolResult",
        id: "call-1",
        toolUseId: "call-1",
        content: "duplicate fallback",
        text: "codex nested output",
      },
      expected: "codex nested output",
    },
    {
      name: "snake-case nested tool_result content fallback",
      block: {
        type: "tool_result",
        content: "fallback output",
      },
      expected: "fallback output",
    },
  ])("serializes $name", ({ block, expected }) => {
    const messages = [
      {
        role: "toolResult",
        content: [block],
      },
    ] as unknown as Message[];

    expect(serializeConversation(messages)).toBe(`[Tool result]: ${expected}`);
  });
});

describe("truncateForSummary", () => {
  it("returns the original text when it fits within maxChars", () => {
    expect(truncateForSummary("hello", 100)).toBe("hello");
  });

  it("truncates long text with a summary notice", () => {
    const input = "x".repeat(200);
    const result = truncateForSummary(input, 100);
    expect(result.length).toBeLessThan(input.length);
    expect(result).toContain("more characters truncated");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    const input = `aa🚀${"b".repeat(200)}`;
    const result = truncateForSummary(input, 80);
    expect(result).not.toContain("�");
  });
});
