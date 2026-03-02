import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  clearThinkingSignatures,
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

describe("clearThinkingSignatures", () => {
  it("returns the original reference when no thinking blocks have signatures", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "world" }] } as AgentMessage,
    ];

    const result = clearThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("returns original reference for thinking blocks without signatures", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final" },
        ],
      } as unknown as AgentMessage,
    ];

    const result = clearThinkingSignatures(messages);
    expect(result).toBe(messages);
  });

  it("clears thinkingSignature while preserving thinking content", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "my reasoning", thinkingSignature: "Evw1234base64==" },
          { type: "text", text: "final answer" },
        ],
      } as unknown as AgentMessage,
    ];

    const result = clearThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(2);
    const thinkingBlock = assistant.content[0] as unknown as Record<string, unknown>;
    expect(thinkingBlock.type).toBe("thinking");
    expect(thinkingBlock.thinking).toBe("my reasoning");
    expect(thinkingBlock.thinkingSignature).toBeUndefined();
    expect((assistant.content[1] as unknown as Record<string, unknown>).text).toBe("final answer");
  });

  it("handles multiple thinking blocks with mixed signature presence", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "unsigned thought" },
          { type: "thinking", thinking: "signed thought", thinkingSignature: "sig123" },
          { type: "text", text: "done" },
        ],
      } as unknown as AgentMessage,
    ];

    const result = clearThinkingSignatures(messages);
    expect(result).not.toBe(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toHaveLength(3);
    // Unsigned block preserved as-is
    expect((assistant.content[0] as unknown as Record<string, unknown>).thinking).toBe(
      "unsigned thought",
    );
    // Signed block has signature cleared
    const signed = assistant.content[1] as unknown as Record<string, unknown>;
    expect(signed.thinking).toBe("signed thought");
    expect(signed.thinkingSignature).toBeUndefined();
  });

  it("preserves non-assistant messages unchanged", () => {
    const userMsg = { role: "user", content: "hello" } as AgentMessage;
    const messages: AgentMessage[] = [userMsg];

    const result = clearThinkingSignatures(messages);
    expect(result).toBe(messages);
  });
});
