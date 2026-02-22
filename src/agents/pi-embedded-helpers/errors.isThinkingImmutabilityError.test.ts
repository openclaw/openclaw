import { describe, expect, it } from "vitest";
import { isThinkingImmutabilityError } from "./errors.js";

describe("isThinkingImmutabilityError", () => {
  it("returns false for empty string", () => {
    expect(isThinkingImmutabilityError("")).toBe(false);
  });

  it("matches the exact Anthropic API error message", () => {
    const raw = "thinking or redacted_thinking blocks in the messages cannot be modified";
    expect(isThinkingImmutabilityError(raw)).toBe(true);
  });

  it("matches when embedded in a longer error payload", () => {
    const raw =
      "400 invalid_request_error: thinking or redacted_thinking blocks" +
      " in the previous assistant turn cannot be modified or removed.";
    expect(isThinkingImmutabilityError(raw)).toBe(true);
  });

  it("is case-insensitive", () => {
    const raw = "Thinking or Redacted_Thinking blocks in the messages CANNOT BE MODIFIED";
    expect(isThinkingImmutabilityError(raw)).toBe(true);
  });

  it("returns false for unrelated role ordering errors", () => {
    expect(isThinkingImmutabilityError("incorrect role information in messages")).toBe(false);
  });

  it("returns false for context overflow errors", () => {
    expect(
      isThinkingImmutabilityError("request_too_large: Request size exceeds model context window"),
    ).toBe(false);
  });

  it("returns false for generic API errors", () => {
    expect(isThinkingImmutabilityError("internal server error")).toBe(false);
  });
});
