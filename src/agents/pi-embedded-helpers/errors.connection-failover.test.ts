import { describe, expect, it } from "vitest";
import { classifyFailoverReason, isFailoverErrorMessage, isTimeoutErrorMessage } from "./errors.js";

describe("connection error failover classification", () => {
  it.each([
    ["Connection error.", "timeout"],
    ["Connection error", "timeout"],
    ["connect error: ECONNREFUSED", "timeout"],
    ["ECONNREFUSED 127.0.0.1:443", "timeout"],
    ["ECONNRESET by peer", "timeout"],
    ["ENOTFOUND api.minimax.io", "timeout"],
    ["EPIPE: broken pipe", "timeout"],
    ["network error", "timeout"],
    ["TypeError: fetch failed", "timeout"],
  ] as const)('classifyFailoverReason("%s") returns "%s"', (input, expected) => {
    expect(classifyFailoverReason(input)).toBe(expected);
  });

  it.each([
    "Connection error.",
    "connect error",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EPIPE",
    "network error",
    "fetch failed",
  ])('isTimeoutErrorMessage("%s") returns true', (input) => {
    expect(isTimeoutErrorMessage(input)).toBe(true);
  });

  it.each(["Connection error.", "ECONNREFUSED 127.0.0.1:443", "network error", "fetch failed"])(
    'isFailoverErrorMessage("%s") returns true',
    (input) => {
      expect(isFailoverErrorMessage(input)).toBe(true);
    },
  );

  it("does not misclassify unrelated errors", () => {
    expect(classifyFailoverReason("invalid JSON in response")).toBeNull();
    expect(classifyFailoverReason("model not found")).toBeNull();
  });
});
