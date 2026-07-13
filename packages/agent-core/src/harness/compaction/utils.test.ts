import { describe, expect, it } from "vitest";
import type { Message } from "../../../../llm-core/src/index.js";
import { serializeConversation } from "./utils.js";

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
