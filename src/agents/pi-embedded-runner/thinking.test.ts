import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  downgradeUnsignedThinkingBlocks,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
} from "./thinking.js";

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
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "final" }]);
  });

  it("keeps assistant turn structure when all content blocks were thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal-only" }],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("downgradeUnsignedThinkingBlocks", () => {
  it("downgrades thinking blocks without signatures to text", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal trace" }],
      }),
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "internal trace" }]);
  });

  it("preserves signed thinking blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal trace", thinkingSignature: "sig" }],
      }),
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking blocks with non-string (object) signatures", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: { id: "rs_test", type: "reasoning" },
          },
        ],
      }),
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });

  it("does not downgrade empty thinking blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      }),
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
    expect((result[0] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      { type: "thinking", thinking: "" },
    ]);
  });

  it("returns original reference when nothing changed", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }),
    ];

    const result = downgradeUnsignedThinkingBlocks(messages);
    expect(result).toBe(messages);
  });
});
