/**
 * Tests for prefix utilities.
 */
import { describe, it, expect } from "vitest";
import { isGroupChatType, shouldEnforcePrefix, applyResponsePrefix } from "./prefix.js";

describe("isGroupChatType", () => {
  it("returns true for group chat types", () => {
    expect(isGroupChatType("group")).toBe(true);
    expect(isGroupChatType("GROUP")).toBe(true);
    expect(isGroupChatType("2")).toBe(true);
    expect(isGroupChatType("multi")).toBe(true);
    expect(isGroupChatType("chat")).toBe(true);
  });

  it("returns false for direct message types", () => {
    expect(isGroupChatType("1")).toBe(false);
    expect(isGroupChatType("dm")).toBe(false);
    expect(isGroupChatType("direct")).toBe(false);
    expect(isGroupChatType("private")).toBe(false);
  });

  it("returns false for undefined/empty", () => {
    expect(isGroupChatType(undefined)).toBe(false);
    expect(isGroupChatType("")).toBe(false);
  });
});

describe("shouldEnforcePrefix", () => {
  it("returns true when prefix is set and chat is group", () => {
    expect(shouldEnforcePrefix("@bot", "group")).toBe(true);
    expect(shouldEnforcePrefix("@bot", "2")).toBe(true);
  });

  it("returns false when prefix is not set", () => {
    expect(shouldEnforcePrefix(undefined, "group")).toBe(false);
    expect(shouldEnforcePrefix("", "group")).toBe(false);
  });

  it("returns false for direct messages", () => {
    expect(shouldEnforcePrefix("@bot", "1")).toBe(false);
    expect(shouldEnforcePrefix("@bot", "dm")).toBe(false);
  });
});

describe("applyResponsePrefix", () => {
  it("returns base text when applyPrefix is false", () => {
    const result = applyResponsePrefix({
      originalText: "Hello world",
      applyPrefix: false,
    });
    expect(result).toBe("Hello world");
  });

  it("returns base text when no responsePrefix", () => {
    const result = applyResponsePrefix({
      originalText: "Hello world",
      applyPrefix: true,
    });
    expect(result).toBe("Hello world");
  });

  it("applies static prefix", () => {
    const result = applyResponsePrefix({
      originalText: "Hello world",
      responsePrefix: "[Bot]",
      applyPrefix: true,
    });
    expect(result).toBe("[Bot] Hello world");
  });

  it("uses cleanedText when available", () => {
    const result = applyResponsePrefix({
      originalText: "  Hello world  ",
      cleanedText: "Hello world",
      responsePrefix: "[Bot]",
      applyPrefix: true,
    });
    expect(result).toBe("[Bot] Hello world");
  });

  it("resolves template variables", () => {
    const result = applyResponsePrefix({
      originalText: "Response",
      responsePrefix: "[{model}]",
      context: { model: "gpt-4" },
      applyPrefix: true,
    });
    expect(result).toBe("[gpt-4] Response");
  });

  it("resolves multiple template variables", () => {
    const result = applyResponsePrefix({
      originalText: "Response",
      responsePrefix: "[{provider}/{model}]",
      context: { model: "gpt-4", provider: "openai" },
      applyPrefix: true,
    });
    expect(result).toBe("[openai/gpt-4] Response");
  });

  it("keeps unresolve variable placeholders", () => {
    const result = applyResponsePrefix({
      originalText: "Response",
      responsePrefix: "[{model}]",
      context: {},
      applyPrefix: true,
    });
    expect(result).toBe("[{model}] Response");
  });

  it("falls back to originalText when cleanedText is empty", () => {
    const result = applyResponsePrefix({
      originalText: "Original",
      cleanedText: "   ",
      responsePrefix: "[Bot]",
      applyPrefix: true,
    });
    expect(result).toBe("[Bot] Original");
  });
});
