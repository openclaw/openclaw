import { describe, expect, it } from "vitest";
import {
  addEmptyThinkingToToolCallMessages,
  hasHistoryToolCallWithoutThinking,
} from "./pi-embedded-helpers.js";

describe("hasHistoryToolCallWithoutThinking", () => {
  it("returns false for empty messages", () => {
    expect(hasHistoryToolCallWithoutThinking([])).toBe(false);
  });

  it("returns false for user messages", () => {
    const input = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(false);
  });

  it("returns false for assistant message with text only", () => {
    const input = [
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(false);
  });

  it("returns true for assistant message with toolCall but no thinking", () => {
    const input = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "tc1", name: "test", arguments: {} },
        ],
      },
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(true);
  });

  it("returns false for assistant message with toolCall and thinking", () => {
    const input = [
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, thinking: "let me think" },
          { type: "toolCall" as const, id: "tc1", name: "test", arguments: {} },
        ],
      },
    ];
    expect(hasHistoryToolCallWithoutThinking(input)).toBe(false);
  });
});

describe("addEmptyThinkingToToolCallMessages", () => {
  it("returns empty array for empty input", () => {
    expect(addEmptyThinkingToToolCallMessages([])).toEqual([]);
  });

  it("does not modify user messages", () => {
    const input = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    ];
    expect(addEmptyThinkingToToolCallMessages(input)).toEqual(input);
  });

  it("does not modify assistant messages without toolCall", () => {
    const input = [
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];
    expect(addEmptyThinkingToToolCallMessages(input)).toEqual(input);
  });

  it("adds empty thinking to assistant message with toolCall but no thinking", () => {
    const input = [
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "tc1", name: "test", arguments: {} },
        ],
      },
    ];
    const result = addEmptyThinkingToToolCallMessages(input as any);
    expect(result).toHaveLength(1);
    expect((result[0] as any).content).toHaveLength(2);
    expect((result[0] as any).content[0]).toEqual({ type: "thinking", thinking: "" });
    expect((result[0] as any).content[1]).toEqual({
      type: "toolCall",
      id: "tc1",
      name: "test",
      arguments: {},
    });
  });

  it("does not modify assistant message that already has thinking", () => {
    const input = [
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, thinking: "existing thought" },
          { type: "toolCall" as const, id: "tc1", name: "test", arguments: {} },
        ],
      },
    ];
    expect(addEmptyThinkingToToolCallMessages(input as any)).toEqual(input);
  });
});
