import { describe, expect, it } from "vitest";
import { matchesTriggerKeywords } from "./trigger-keywords.js";

describe("matchesTriggerKeywords", () => {
  it("returns false when disabled", () => {
    expect(matchesTriggerKeywords("所有人 看一下", { enabled: false, keywords: ["所有人"] })).toBe(
      false,
    );
  });

  it("matches by substring (case-insensitive)", () => {
    expect(matchesTriggerKeywords("Jarvis 在吗", { enabled: true, keywords: ["jarvis"] })).toBe(
      true,
    );
  });

  it("matches Chinese keywords", () => {
    expect(matchesTriggerKeywords("所有人 看一下", { enabled: true, keywords: ["所有人"] })).toBe(
      true,
    );
  });

  it("ignores empty keywords", () => {
    expect(matchesTriggerKeywords("hello", { enabled: true, keywords: ["", "   "] })).toBe(false);
  });
});
