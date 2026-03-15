import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  dropThinkingBlocks,
  isAssistantMessageWithContent,
  stripThinkingFromNonLatestAssistant,
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

  it("drops redacted_thinking blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque-base64-data" },
          { type: "text", text: "visible" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "visible" }]);
  });

  it("drops both thinking and redacted_thinking blocks in the same message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
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

describe("stripThinkingFromNonLatestAssistant", () => {
  it("returns original reference when no assistant messages have thinking blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hi" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    expect(result).toBe(messages);
  });

  it("returns original reference with zero or one assistant message", () => {
    const single: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought" },
          { type: "text", text: "answer" },
        ],
      }),
    ];
    expect(stripThinkingFromNonLatestAssistant(single)).toBe(single);
  });

  it("preserves thinking blocks in the latest assistant message only", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old thought" },
          { type: "text", text: "old answer" },
        ],
      }),
      castAgentMessage({ role: "user", content: "follow up" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "new thought" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "new answer" },
        ],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    expect(result).not.toBe(messages);

    // First assistant: thinking stripped
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "old answer" }]);

    // Latest assistant: thinking preserved exactly
    const latest = result[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(latest.content).toEqual([
      { type: "thinking", thinking: "new thought" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "new answer" },
    ]);
  });

  it("strips redacted_thinking blocks from non-latest assistant messages", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "old-opaque" },
          { type: "text", text: "first" },
        ],
      }),
      castAgentMessage({ role: "user", content: "next" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "first" }]);

    // Latest assistant untouched (no thinking blocks to worry about)
    const latest = result[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(latest.content).toEqual([{ type: "text", text: "second" }]);
  });

  it("replaces with empty text block when all blocks in non-latest are thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "only thinking" },
          { type: "redacted_thinking", data: "opaque" },
        ],
      }),
      castAgentMessage({ role: "user", content: "next" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "latest" }],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "" }]);
  });

  it("handles interleaved user and toolResult messages correctly", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thought 1" },
          { type: "text", text: "call tool" },
        ],
      }),
      castAgentMessage({ role: "toolResult", content: "result" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thought 2" },
          { type: "text", text: "final" },
        ],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    // First assistant: thinking stripped
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "call tool" }]);

    // toolResult: unchanged
    expect(result[1]).toBe(messages[1]);

    // Latest assistant: thinking preserved
    const latest = result[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(latest.content).toEqual([
      { type: "thinking", thinking: "thought 2" },
      { type: "text", text: "final" },
    ]);
  });
});
