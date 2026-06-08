import { describe, expect, it } from "vitest";
import { estimateVisemes } from "./viseme-estimate.js";

describe("estimateVisemes", () => {
  it("returns nothing for empty text or non-positive duration", () => {
    expect(estimateVisemes("", 1000)).toEqual([]);
    expect(estimateVisemes("   ", 1000)).toEqual([]);
    expect(estimateVisemes(null, 1000)).toEqual([]);
    expect(estimateVisemes("hello", 0)).toEqual([]);
    expect(estimateVisemes("hello", -5)).toEqual([]);
  });

  it("returns nothing when no characters map to a viseme", () => {
    expect(estimateVisemes("123 !?", 1000)).toEqual([]);
  });

  it("emits one mark per viseme change, in time order within the duration", () => {
    const marks = estimateVisemes("ma", 1000);
    // m -> 21 (closed), a -> 2 (open)
    expect(marks.map((m) => m.visemeId)).toEqual([21, 2]);
    expect(marks[0].tMs).toBe(0);
    expect(marks[1].tMs).toBeGreaterThan(0);
    for (const m of marks) {
      expect(m.tMs).toBeGreaterThanOrEqual(0);
      expect(m.tMs).toBeLessThanOrEqual(1000);
    }
  });

  it("collapses consecutive identical visemes", () => {
    // "mmm" is three closed-lip visemes → a single mark.
    const marks = estimateVisemes("mmm", 900);
    expect(marks).toHaveLength(1);
    expect(marks[0].visemeId).toBe(21);
  });

  it("inserts a silence viseme between words", () => {
    const marks = estimateVisemes("a a", 900);
    // a(2) space(0) a(2) → 2, 0, 2 after collapsing
    expect(marks.map((m) => m.visemeId)).toEqual([2, 0, 2]);
  });

  it("keeps timestamps non-decreasing", () => {
    const marks = estimateVisemes("the quick brown fox", 2000);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i].tMs).toBeGreaterThanOrEqual(marks[i - 1].tMs);
    }
  });
});
