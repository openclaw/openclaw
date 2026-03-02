import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  downgradeUnsignedThinkingBlocks,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
} from "./thinking.js";

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

describe("downgradeUnsignedThinkingBlocks", () => {
  it("downgrades thinking blocks without signatures to text", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal trace" }],
      } as unknown as AgentMessage,
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "internal trace" }]);
  });

  it("preserves signed thinking blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal trace", thinkingSignature: "sig" }],
      } as unknown as AgentMessage,
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });


  it("preserves thinking blocks with non-string (object) signatures", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: { id: "rs_test", type: "reasoning" },
          },
        ],
      } as unknown as AgentMessage,
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("does not downgrade empty thinking blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      } as unknown as AgentMessage,
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
    expect((result[0] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      { type: "thinking", thinking: "" },
    ]);
  });

  it("returns original reference when nothing changed", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "world" }] } as AgentMessage,
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });
});
