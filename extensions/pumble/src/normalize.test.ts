import { describe, expect, it } from "vitest";
import { looksLikePumbleTargetId, normalizePumbleMessagingTarget } from "./normalize.js";

describe("normalizePumbleMessagingTarget", () => {
  it("keeps channel: prefix", () => {
    expect(normalizePumbleMessagingTarget("channel:CH123")).toBe("channel:CH123");
  });

  it("keeps user: prefix", () => {
    expect(normalizePumbleMessagingTarget("user:U123")).toBe("user:U123");
  });

  it("converts pumble: to user:", () => {
    expect(normalizePumbleMessagingTarget("pumble:U456")).toBe("user:U456");
  });

  it("converts # prefix to channel:", () => {
    expect(normalizePumbleMessagingTarget("#general")).toBe("channel:general");
  });

  it("converts email to user:", () => {
    expect(normalizePumbleMessagingTarget("alice@example.com")).toBe("user:alice@example.com");
  });

  it("treats plain ID as channel:", () => {
    expect(normalizePumbleMessagingTarget("ABCDEF1234")).toBe("channel:ABCDEF1234");
  });

  it("returns undefined for empty string", () => {
    expect(normalizePumbleMessagingTarget("")).toBeUndefined();
  });

  it("returns undefined for # with no name", () => {
    expect(normalizePumbleMessagingTarget("#")).toBeUndefined();
  });
});

describe("looksLikePumbleTargetId", () => {
  it("recognizes user: prefix", () => {
    expect(looksLikePumbleTargetId("user:U123")).toBe(true);
  });

  it("recognizes channel: prefix", () => {
    expect(looksLikePumbleTargetId("channel:CH123")).toBe(true);
  });

  it("recognizes pumble: prefix", () => {
    expect(looksLikePumbleTargetId("pumble:U456")).toBe(true);
  });

  it("recognizes # prefix", () => {
    expect(looksLikePumbleTargetId("#general")).toBe(true);
  });

  it("recognizes email", () => {
    expect(looksLikePumbleTargetId("alice@example.com")).toBe(true);
  });

  it("recognizes 8+ char alphanumeric ID", () => {
    expect(looksLikePumbleTargetId("ABCDEF1234")).toBe(true);
  });

  it("rejects short plain string", () => {
    expect(looksLikePumbleTargetId("hi")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(looksLikePumbleTargetId("")).toBe(false);
  });
});
