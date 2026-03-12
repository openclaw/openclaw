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

  it("drops redacted_thinking blocks", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(result).not.toBe(messages);
    expect(assistant.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops both thinking and redacted_thinking blocks from the same message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "redacted_thinking", data: "secret" },
          { type: "text", text: "result" },
        ],
      }),
    ];

    const result = dropThinkingBlocks(messages);
    const assistant = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(assistant.content).toEqual([{ type: "text", text: "result" }]);
  });
});

describe("stripThinkingFromNonLatestAssistant", () => {
  it("returns original reference when no thinking blocks exist", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    expect(result).toBe(messages);
  });

  it("preserves thinking blocks in the latest assistant message", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({ role: "user", content: "hello" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    // Latest assistant is the only assistant — nothing should change.
    expect(result).toBe(messages);
  });

  it("strips thinking from non-latest assistant messages", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning" },
          { type: "text", text: "old answer" },
        ],
      }),
      castAgentMessage({ role: "user", content: "follow-up" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "new reasoning" },
          { type: "text", text: "new answer" },
        ],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    const last = result[2] as Extract<AgentMessage, { role: "assistant" }>;

    // Non-latest: thinking stripped
    expect(first.content).toEqual([{ type: "text", text: "old answer" }]);
    // Latest: thinking preserved
    expect(last.content).toEqual([
      { type: "thinking", thinking: "new reasoning" },
      { type: "text", text: "new answer" },
    ]);
  });

  it("strips redacted_thinking from non-latest assistant messages", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "old answer" },
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
    expect(first.content).toEqual([{ type: "text", text: "old answer" }]);
  });

  it("handles interleaved user/toolResult messages correctly", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1" },
          { type: "text", text: "use tool" },
        ],
      }),
      castAgentMessage({ role: "toolResult", content: "tool output" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 2" },
          { type: "text", text: "final" },
        ],
      }),
      castAgentMessage({ role: "user", content: "thanks" }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    const second = result[2] as Extract<AgentMessage, { role: "assistant" }>;

    // First assistant: non-latest → stripped
    expect(first.content).toEqual([{ type: "text", text: "use tool" }]);
    // Second assistant: latest → preserved
    expect(second.content).toEqual([
      { type: "thinking", thinking: "step 2" },
      { type: "text", text: "final" },
    ]);
  });

  it("replaces with empty text block when all content was thinking", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "thinking", thinking: "only thinking" }],
      }),
      castAgentMessage({ role: "user", content: "hi" }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "latest" }],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    const first = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(first.content).toEqual([{ type: "text", text: "" }]);
  });

  it("returns original reference when no changes needed", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "no thinking here" }],
      }),
      castAgentMessage({ role: "user", content: "ok" }),
      castAgentMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "only latest has thinking" },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const result = stripThinkingFromNonLatestAssistant(messages);
    expect(result).toBe(messages);
  });
});
