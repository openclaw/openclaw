import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  addEmptyThinkingToToolCallMessages,
  hasHistoryToolCallWithoutThinking,
} from "./pi-embedded-helpers.js";

function assistantMessage(content: AgentMessage["content"]): AgentMessage {
  return {
    role: "assistant",
    content,
  } as AgentMessage;
}

describe("hasHistoryToolCallWithoutThinking", () => {
  it("returns false for empty input", () => {
    expect(hasHistoryToolCallWithoutThinking([])).toBe(false);
  });

  it("returns true when assistant toolCall has no thinking", () => {
    const input = [assistantMessage([{ type: "toolCall", id: "tc1", name: "test", arguments: {} }])];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(true);
  });

  it("returns false when assistant toolCall already has thinking", () => {
    const input = [
      assistantMessage([
        { type: "thinking", thinking: "existing thought" },
        { type: "toolCall", id: "tc1", name: "test", arguments: {} },
      ]),
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(false);
  });

  it("returns false for non-assistant messages", () => {
    const input = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      } as AgentMessage,
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(false);
  });
});

describe("addEmptyThinkingToToolCallMessages", () => {
  it("returns empty input unchanged", () => {
    expect(addEmptyThinkingToToolCallMessages([])).toEqual([]);
  });

  it("prepends empty thinking to assistant toolCall without thinking", () => {
    const input = [assistantMessage([{ type: "toolCall", id: "tc1", name: "test", arguments: {} }])];

    expect(addEmptyThinkingToToolCallMessages(input)).toEqual([
      assistantMessage([
        { type: "thinking", thinking: "" },
        { type: "toolCall", id: "tc1", name: "test", arguments: {} },
      ]),
    ]);
  });

  it("leaves assistant message unchanged when thinking already exists", () => {
    const input = [
      assistantMessage([
        { type: "thinking", thinking: "existing thought" },
        { type: "toolCall", id: "tc1", name: "test", arguments: {} },
      ]),
    ];

    expect(addEmptyThinkingToToolCallMessages(input)).toEqual(input);
  });

  it("leaves non-assistant messages unchanged", () => {
    const input = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "done" }],
      } as AgentMessage,
    ];

    expect(addEmptyThinkingToToolCallMessages(input)).toEqual(input);
  });
});
