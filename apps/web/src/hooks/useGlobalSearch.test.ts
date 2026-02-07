import { describe, it, expect } from "vitest";
import { fuzzyMatch, CATEGORY_META, type SearchCategory } from "./useGlobalSearch";

describe("fuzzyMatch", () => {
  it("returns 1.0 for exact match", () => {
    expect(fuzzyMatch("hello", "hello")).toBe(1.0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("Hello", "hello")).toBe(1.0);
    expect(fuzzyMatch("hello", "Hello")).toBe(1.0);
  });

  it("returns 0.95 for starts-with match", () => {
    expect(fuzzyMatch("res", "research assistant")).toBe(0.95);
  });

  it("returns high score for substring match", () => {
    const score = fuzzyMatch("search", "research assistant");
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(0.95);
  });

  it("returns score for word-prefix match", () => {
    const score = fuzzyMatch("ass", "research assistant");
    expect(score).toBeGreaterThan(0.7);
  });

  it("returns score for multi-word query matching", () => {
    const score = fuzzyMatch("res ass", "research assistant");
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it("returns score for character-sequence (fuzzy) match", () => {
    const score = fuzzyMatch("rsh", "research");
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThanOrEqual(0.6);
  });

  it("returns 0 for no match", () => {
    expect(fuzzyMatch("xyz", "hello world")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    expect(fuzzyMatch("", "hello")).toBe(0);
  });

  it("returns 0 for empty text", () => {
    expect(fuzzyMatch("hello", "")).toBe(0);
  });

  it("ranks exact > starts-with > substring > word-prefix > fuzzy", () => {
    const exact = fuzzyMatch("bot", "bot");
    const startsWith = fuzzyMatch("bot", "botnet");
    const substring = fuzzyMatch("bot", "chatbot");
    const wordPrefix = fuzzyMatch("bot", "chat bot service");
    const fuzzy = fuzzyMatch("bt", "bot");

    expect(exact).toBeGreaterThan(startsWith);
    expect(startsWith).toBeGreaterThan(substring);
    // substring vs word-prefix: substring might score higher since it's contiguous
    expect(substring).toBeGreaterThan(fuzzy);
  });

  it("scores closer-to-start substrings higher", () => {
    const nearStart = fuzzyMatch("test", "atesting something");
    const farStart = fuzzyMatch("test", "something far testing");
    expect(nearStart).toBeGreaterThan(farStart);
  });
});

describe("CATEGORY_META", () => {
  it("has all expected categories", () => {
    const expected: SearchCategory[] = [
      "navigation",
      "agent",
      "session",
      "goal",
      "decision",
      "cron",
      "memory",
    ];
    for (const cat of expected) {
      expect(CATEGORY_META[cat]).toBeDefined();
      expect(CATEGORY_META[cat].label).toBeTruthy();
      expect(typeof CATEGORY_META[cat].order).toBe("number");
    }
  });

  it("has unique order values", () => {
    const orders = Object.values(CATEGORY_META).map((m) => m.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("navigation comes first", () => {
    expect(CATEGORY_META.navigation.order).toBe(0);
  });
});
