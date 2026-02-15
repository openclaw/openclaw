import { describe, expect, it } from "vitest";
import { stripThinkingFromAssistantToolCallMessages } from "./toolcall-thinking.js";

describe("stripThinkingFromAssistantToolCallMessages", () => {
  it("returns original context when no messages", () => {
    const ctx = { messages: [] as unknown[] };
    expect(stripThinkingFromAssistantToolCallMessages(ctx)).toBe(ctx);
  });

  it("returns original context when no assistant tool calls include thinking", () => {
    const ctx = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "1", name: "t", arguments: {} }],
        },
      ],
    };

    expect(stripThinkingFromAssistantToolCallMessages(ctx)).toBe(ctx);
  });

  it("strips thinking blocks when an assistant message includes tool calls", () => {
    const ctx = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "toolCall", id: "1", name: "t", arguments: {} },
            { type: "text", text: "ok" },
          ],
        },
      ],
    };

    const sanitized = stripThinkingFromAssistantToolCallMessages(ctx) as {
      messages: Array<{ role: string; content?: Array<{ type?: string }> }>;
    };

    expect(sanitized).not.toBe(ctx);
    expect(sanitized.messages[1]?.content?.some((b) => b.type === "thinking")).toBe(false);
    expect(sanitized.messages[1]?.content?.some((b) => b.type === "toolCall")).toBe(true);
  });

  it("strips top-level thinking when an assistant message includes tool calls", () => {
    const ctx = {
      messages: [
        {
          role: "assistant",
          thinking: "separate thinking field",
          content: [{ type: "toolCall", id: "1", name: "t", arguments: {} }],
        },
      ],
    };

    const sanitized = stripThinkingFromAssistantToolCallMessages(ctx) as {
      messages: Array<{ role: string; thinking?: unknown }>;
    };

    expect(sanitized).not.toBe(ctx);
    expect(sanitized.messages[0]?.thinking).toBeUndefined();
  });
});
