import { describe, expect, it } from "vitest";
import { estimateVisemes, visemesFromAlignment } from "./viseme-estimate.js";

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

describe("visemesFromAlignment", () => {
  it("returns nothing for empty input or all-silence/punctuation", () => {
    expect(visemesFromAlignment([], [])).toEqual([]);
    expect(visemesFromAlignment([" ", " "], [0, 0.1])).toEqual([]);
    expect(visemesFromAlignment(["1", "?", "!"], [0, 0.1, 0.2])).toEqual([]);
  });

  it("uses each character's REAL start time as the mark time", () => {
    // "ma" → m(21) at 0.10s, a(2) at 0.30s
    const marks = visemesFromAlignment(["m", "a"], [0.1, 0.3]);
    expect(marks).toEqual([
      { tMs: 100, visemeId: 21 },
      { tMs: 300, visemeId: 2 },
    ]);
  });

  it("collapses consecutive identical visemes to the first occurrence's time", () => {
    const marks = visemesFromAlignment(["m", "m", "a"], [0, 0.05, 0.2]);
    expect(marks).toEqual([
      { tMs: 0, visemeId: 21 },
      { tMs: 200, visemeId: 2 },
    ]);
  });

  it("tolerates ragged arrays and skips unmapped chars", () => {
    // '1' skipped; 'o' round(8) at 0.5s; extra time entry ignored.
    expect(visemesFromAlignment(["1", "o"], [0, 0.5, 0.9])).toEqual([{ tMs: 500, visemeId: 8 }]);
  });
});
