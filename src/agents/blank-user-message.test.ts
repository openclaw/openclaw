import { describe, expect, it } from "vitest";
import { dropBlankUserMessages, repairBlankUserMessageContent } from "./blank-user-message.js";

describe("repairBlankUserMessageContent", () => {
  it("keeps non-blank string content", () => {
    expect(repairBlankUserMessageContent("hello")).toEqual({ kind: "keep" });
  });

  it("drops empty string content", () => {
    expect(repairBlankUserMessageContent("")).toEqual({ kind: "drop" });
  });

  it("drops whitespace-only string content", () => {
    expect(repairBlankUserMessageContent("   \t\n ")).toEqual({ kind: "drop" });
  });

  it("keeps unknown content shapes verbatim", () => {
    expect(repairBlankUserMessageContent(undefined)).toEqual({ kind: "keep" });
    expect(repairBlankUserMessageContent(42)).toEqual({ kind: "keep" });
  });

  it("drops array content composed only of blank text blocks", () => {
    expect(repairBlankUserMessageContent([{ type: "text", text: "" }])).toEqual({ kind: "drop" });
  });

  it("rewrites array content by removing blank text blocks while preserving non-text blocks", () => {
    const result = repairBlankUserMessageContent([
      { type: "text", text: "   " },
      { type: "image", data: "AA==" },
    ]);
    expect(result).toEqual({
      kind: "rewrite",
      content: [{ type: "image", data: "AA==" }],
    });
  });

  it("keeps array content untouched when no blank text blocks are present", () => {
    const content = [
      { type: "text", text: "real" },
      { type: "image", data: "AA==" },
    ];
    expect(repairBlankUserMessageContent(content)).toEqual({ kind: "keep" });
  });
});

describe("dropBlankUserMessages", () => {
  it("returns the same reference and zero count when nothing is touched", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const result = dropBlankUserMessages(messages);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("drops only blank user messages, leaving other roles untouched", () => {
    const messages = [
      { role: "assistant", content: "" },
      { role: "user", content: "" },
      { role: "user", content: "real" },
    ];
    const result = dropBlankUserMessages(messages);
    expect(result.droppedCount).toBe(1);
    expect(result.messages).toEqual([
      { role: "assistant", content: "" },
      { role: "user", content: "real" },
    ]);
  });

  it("rewrites partially-blank user messages and counts only fully-dropped ones", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "   " },
          { type: "image", data: "AA==" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "" }] },
    ];
    const result = dropBlankUserMessages(messages);
    expect(result.droppedCount).toBe(1);
    expect(result.messages).toEqual([{ role: "user", content: [{ type: "image", data: "AA==" }] }]);
  });
});
