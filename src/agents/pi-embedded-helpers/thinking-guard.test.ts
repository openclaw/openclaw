import { describe, expect, it } from "vitest";
import { isImmutableThinkingBlock } from "./thinking-guard.js";

describe("isImmutableThinkingBlock", () => {
  it("returns true for thinking blocks", () => {
    expect(isImmutableThinkingBlock({ type: "thinking", thinking: "some thought" })).toBe(true);
  });

  it("returns true for redacted_thinking blocks", () => {
    expect(isImmutableThinkingBlock({ type: "redacted_thinking", data: "encrypted-payload" })).toBe(
      true,
    );
  });

  it("returns false for text blocks", () => {
    expect(isImmutableThinkingBlock({ type: "text", text: "hello" })).toBe(false);
  });

  it("returns false for image blocks", () => {
    expect(isImmutableThinkingBlock({ type: "image", data: "base64" })).toBe(false);
  });

  it("returns false for null/undefined/primitives", () => {
    expect(isImmutableThinkingBlock(null)).toBe(false);
    expect(isImmutableThinkingBlock(undefined)).toBe(false);
    expect(isImmutableThinkingBlock("string")).toBe(false);
    expect(isImmutableThinkingBlock(42)).toBe(false);
  });
});
