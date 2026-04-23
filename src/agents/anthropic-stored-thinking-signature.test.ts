import { describe, expect, it } from "vitest";
import { resolveAnthropicStoredThinkingSignature } from "./anthropic-stored-thinking-signature.js";

describe("resolveAnthropicStoredThinkingSignature", () => {
  it("prefers non-empty thinkingSignature", () => {
    expect(
      resolveAnthropicStoredThinkingSignature({
        thinkingSignature: "a",
        signature: "b",
      }),
    ).toBe("a");
  });

  it("falls back to signature when thinkingSignature is empty after trim", () => {
    expect(
      resolveAnthropicStoredThinkingSignature({
        thinkingSignature: "",
        signature: "sig",
      }),
    ).toBe("sig");
  });

  it("returns undefined when both are missing or blank", () => {
    expect(resolveAnthropicStoredThinkingSignature({})).toBeUndefined();
    expect(
      resolveAnthropicStoredThinkingSignature({ thinkingSignature: "  " }),
    ).toBeUndefined();
  });
});
