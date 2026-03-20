import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { dropThinkingBlocks, isAssistantMessageWithContent } from "./thinking.js";

function dropSingleAssistantContent(content: Array<Record<string, unknown>>) {
  const messages: AgentMessage[] = [
    castAgentMessage({
      role: "assistant",
      content,
    }),
  ];

  const result = dropThinkingBlocks(messages);
  return {
    assistant: result[0] as Extract<AgentMessage, { role: "assistant" }>,
    messages,
    result,
  };
}

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    const user = castAgentMessage({ role: "user", content: "hi" });
    const malformed = castAgentMessage({ role: "assistant", content: "not-array" });

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("drops thinking blocks while preserving non-thinking assistant content", () => {
    const { assistant, messages, result } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "final" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const { assistant } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal-only" },
    ]);
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });
});
