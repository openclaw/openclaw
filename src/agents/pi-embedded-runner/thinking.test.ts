import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { dropThinkingBlocks, isAssistantMessageWithContent } from "./thinking.js";

describe("isAssistantMessageWithContent", () => {
  it("accepts assistant messages with array content and rejects others", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    } as AgentMessage;
    const user = { role: "user", content: "hi" } as AgentMessage;
    const malformed = { role: "assistant", content: "not-array" } as unknown as AgentMessage;

    expect(isAssistantMessageWithContent(assistant)).toBe(true);
    expect(isAssistantMessageWithContent(user)).toBe(false);
    expect(isAssistantMessageWithContent(malformed)).toBe(false);
  });
});

describe("dropThinkingBlocks", () => {
  it("returns the original reference when no thinking blocks are present", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "world" }] } as AgentMessage,
    ];

    const result = dropThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("drops thinking blocks while preserving non-thinking assistant content", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final" },
        ],
      } as unknown as AgentMessage,
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "final" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal-only" }],
      } as unknown as AgentMessage,
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });
});
