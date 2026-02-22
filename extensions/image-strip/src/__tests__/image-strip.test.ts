import { describe, it, expect } from "vitest";
import {
  stripImageBlocksFromMessages,
  isEmptyAssistantContent,
} from "../image-strip.js";

describe("isEmptyAssistantContent", () => {
  it("returns true for assistant with empty string content", () => {
    expect(isEmptyAssistantContent({ role: "assistant", content: "" })).toBe(true);
  });

  it("returns true for assistant with empty array content", () => {
    expect(isEmptyAssistantContent({ role: "assistant", content: [] })).toBe(true);
  });

  it("returns true for assistant with whitespace-only text blocks", () => {
    expect(
      isEmptyAssistantContent({
        role: "assistant",
        content: [{ type: "text", text: "  \n " }],
      }),
    ).toBe(true);
  });

  it("returns false for non-assistant roles", () => {
    expect(isEmptyAssistantContent({ role: "user", content: "" })).toBe(false);
  });

  it("returns false for assistant with actual content", () => {
    expect(
      isEmptyAssistantContent({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBe(false);
  });
});

describe("stripImageBlocksFromMessages", () => {
  it("replaces image blocks with placeholder text", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { data: "base64..." } },
        ],
      },
    ];
    const result = stripImageBlocksFromMessages(messages);
    expect(result.hadImages).toBe(true);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "describe this" },
      { type: "text", text: "[image omitted]" },
    ]);
  });

  it("removes empty assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [] },
    ];
    const result = stripImageBlocksFromMessages(messages);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("returns hadImages=false when no images present", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const result = stripImageBlocksFromMessages(messages);
    expect(result.hadImages).toBe(false);
  });

  it("handles nested content in toolResult blocks", () => {
    const messages = [
      {
        role: "toolResult",
        content: [
          {
            type: "result",
            content: [{ type: "image", source: { data: "x" } }],
          },
        ],
      },
    ];
    const result = stripImageBlocksFromMessages(messages);
    expect(result.hadImages).toBe(true);
    const block = (result.messages[0].content as unknown[])[0] as Record<string, unknown>;
    expect((block.content as unknown[])[0]).toEqual({ type: "text", text: "[image omitted]" });
  });
});
