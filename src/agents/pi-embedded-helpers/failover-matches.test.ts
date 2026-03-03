import { describe, expect, it } from "vitest";
import { classifyFailoverReason, isFailoverErrorMessage } from "./errors.js";
import { isOverloadedErrorMessage } from "./failover-matches.js";

describe("overloaded errors classify as rate_limit for provider-wide failover (#32533)", () => {
  const overloadedMessages = [
    "The AI service is temporarily overloaded. Please try again in a moment.",
    'overloaded_error: {"type":"overloaded_error","message":"overloaded"}',
    "service unavailable",
    "high demand",
    "Anthropic is currently experiencing high demand",
  ];

  for (const msg of overloadedMessages) {
    it(`isOverloadedErrorMessage matches: "${msg.slice(0, 60)}"`, () => {
      expect(isOverloadedErrorMessage(msg)).toBe(true);
    });

    it(`classifyFailoverReason returns rate_limit for overloaded: "${msg.slice(0, 60)}"`, () => {
      expect(classifyFailoverReason(msg)).toBe("rate_limit");
    });

    it(`isFailoverErrorMessage matches overloaded: "${msg.slice(0, 60)}"`, () => {
      expect(isFailoverErrorMessage(msg)).toBe(true);
    });
  }

  it("rate_limit errors also classified as rate_limit", () => {
    expect(classifyFailoverReason("rate limit exceeded")).toBe("rate_limit");
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
  });
});
