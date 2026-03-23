import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  assertReplayProtectionIntact,
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  latestAssistantMessageHasReplayProtectedBlocks,
} from "./thinking.js";

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
  it("detects replay-protected blocks on the latest assistant turn", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "older" }] }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "opaque" }],
      }),
    ];

    expect(latestAssistantMessageHasReplayProtectedBlocks(messages)).toBe(true);
  });

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

  it("preserves the latest assistant message when requested", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "older-internal" },
          { type: "text", text: "older-final" },
        ],
      }),
      castAgentMessage({ role: "user", content: "follow up" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest-internal" },
          { type: "text", text: "latest-final" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages, { preserveLatestAssistantMessage: true });
    const firstAssistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    const latestAssistant = result[2] as Extract<AgentMessage, { role: "assistant" }>;

    expect(result).not.toBe(messages);
    expect(firstAssistant.content).toEqual([{ type: "text", text: "older-final" }]);
    expect(latestAssistant.content).toEqual(messages[2]?.content);
  });

  it("keeps the latest assistant turn unchanged even when it only contains thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "latest-internal-only" }],
      }),
    ];

    const result = dropThinkingBlocks(messages, { preserveLatestAssistantMessage: true });
    expect(result).toBe(messages);
  });

  it("drops replay-protected blocks from the latest assistant when preservation is disabled", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest-internal-only" },
          { type: "text", text: "latest-final" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages, { preserveLatestAssistantMessage: false });
    const latestAssistant = result[1] as Extract<AgentMessage, { role: "assistant" }>;

    expect(result).not.toBe(messages);
    expect(latestAssistant.content).toEqual([{ type: "text", text: "latest-final" }]);
  });
});

describe("assertReplayProtectionIntact", () => {
  it("accepts unchanged replay-protected latest assistant messages", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" }],
      }),
    ];

    expect(() => assertReplayProtectionIntact(messages, messages, "thinking:test")).not.toThrow();
  });

  it("throws when the replay-protected latest assistant changes", () => {
    const original: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" }],
      }),
    ];
    const transformed: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "reasoning removed" }],
      }),
    ];

    expect(() => assertReplayProtectionIntact(original, transformed, "thinking:test")).toThrow(
      "thinking:test: replay-protected latest assistant message changed",
    );
  });
});
