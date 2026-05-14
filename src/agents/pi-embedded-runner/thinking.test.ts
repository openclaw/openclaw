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

  it("preserves thinking blocks when the assistant message is the latest assistant turn", () => {
    const { assistant, messages, result } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
    expect(result).toBe(messages);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "final" },
    ]);
  });

  it("preserves a latest assistant turn even when all content blocks are thinking", () => {
    const { assistant } = dropSingleAssistantContent([
      { type: "thinking", thinking: "internal-only" },
    ]);
    expect(assistant.content).toEqual([{ type: "thinking", thinking: "internal-only" }]);
  });

  it("preserves thinking blocks in the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "first" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old" },
          { type: "text", text: "old text" },
        ],
      }),
      castAgentMessage({ role: "user", content: "second" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
          { type: "text", text: "latest text" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const firstAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[3] as Extract<AgentMessage, { role: "assistant" }>;

    expect(firstAssistant.content).toEqual([{ type: "text", text: "old text" }]);
    expect(latestAssistant.content).toEqual([
      { type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
      { type: "text", text: "latest text" },
    ]);
  });
});
