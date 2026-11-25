// Signal tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";

describe("normalizeSignalMessagingTarget", () => {
  it("canonicalizes username target prefixes", () => {
    expect(normalizeSignalMessagingTarget("username:Alice.42")).toBe("username:alice.42");
    expect(normalizeSignalMessagingTarget("signal:u:Alice.42")).toBe("username:alice.42");
  });
});

describe("looksLikeSignalTargetId", () => {
  it("accepts compact UUIDs for target detection", () => {
    expect(looksLikeSignalTargetId("123e4567e89b12d3a456426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("uuid:123e4567e89b12d3a456426614174000")).toBe(true);
  });

  it("rejects invalid uuid prefixes", () => {
    expect(looksLikeSignalTargetId("uuid:")).toBe(false);
    expect(looksLikeSignalTargetId("uuid:not-a-uuid")).toBe(false);
  });
});
