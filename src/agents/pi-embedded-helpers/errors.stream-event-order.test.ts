import { describe, expect, it } from "vitest";
import { isStreamEventOrderError } from "./errors.js";

describe("isStreamEventOrderError", () => {
  it("matches Anthropic SDK message_start before message_stop error", () => {
    expect(
      isStreamEventOrderError(
        'Unexpected event order, got message_start before receiving "message_stop"',
      ),
    ).toBe(true);
  });

  it("matches case-insensitive variant", () => {
    expect(isStreamEventOrderError("unexpected event order")).toBe(true);
  });

  it("matches when embedded in a longer message", () => {
    expect(
      isStreamEventOrderError(
        'AnthropicError: Unexpected event order, got message_start before receiving "message_stop"',
      ),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isStreamEventOrderError("request_too_large: context window exceeded")).toBe(false);
    expect(isStreamEventOrderError("rate limit exceeded")).toBe(false);
    expect(isStreamEventOrderError("")).toBe(false);
    expect(isStreamEventOrderError("LLM request failed.")).toBe(false);
  });
});
