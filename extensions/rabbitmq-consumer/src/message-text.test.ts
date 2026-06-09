import { describe, expect, it } from "vitest";
import { extractMessageText } from "./message-text.js";

describe("extractMessageText", () => {
  it("returns a string as-is", () => {
    expect(extractMessageText("hello")).toBe("hello");
  });

  it("joins the text of an array of content blocks", () => {
    expect(
      extractMessageText([
        { type: "text", text: "块状" },
        { type: "text", text: "答案" },
      ]),
    ).toBe("块状答案");
  });

  it("handles string blocks and skips non-text blocks", () => {
    const content = [
      "a",
      { type: "tool_use", id: "x" },
      { type: "text", text: "b" },
      { type: "text" },
    ];
    expect(extractMessageText(content)).toBe("ab");
  });

  it("returns an empty string for null/undefined/object content", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText({ foo: "bar" })).toBe("");
  });
});
