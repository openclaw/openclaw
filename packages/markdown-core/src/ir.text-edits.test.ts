import { describe, expect, it } from "vitest";
import { applyMarkdownTextEdits } from "./ir-spans.js";

describe("applyMarkdownTextEdits", () => {
  it("projects UTF-16 formatting boundaries through insertion, replacement, and removal", () => {
    const result = applyMarkdownTextEdits("😀 abc tail", [
      { start: 7, end: 11, text: "" },
      { start: 0, end: 0, text: "#" },
      { start: 3, end: 6, text: "`abc`" },
    ]);

    expect(result.text).toBe("#😀 `abc` ");
    expect([0, 2, 3, 6, 7, 11].map(result.mapOffset)).toEqual([1, 3, 4, 9, 10, 10]);
    expect(result.text.slice(result.mapOffset(3), result.mapOffset(6))).toBe("`abc`");
  });

  it("keeps equal-position insertions in caller order and leaves an empty projection unchanged", () => {
    const result = applyMarkdownTextEdits("XY", [
      { start: 1, end: 1, text: "first" },
      { start: 1, end: 1, text: "second" },
    ]);

    expect(result.text).toBe("XfirstsecondY");
    expect(result.mapOffset(1)).toBe(12);
    const unchanged = applyMarkdownTextEdits("😀XY", []);
    expect(unchanged.text).toBe("😀XY");
    expect(unchanged.mapOffset(2)).toBe(2);
  });

  it("applies boundary insertions before replacing the following source range", () => {
    const result = applyMarkdownTextEdits("AB", [
      { start: 1, end: 2, text: "XY" },
      { start: 1, end: 1, text: "b" },
    ]);

    expect(result.text).toBe("AbXY");
    expect([1, 2].map(result.mapOffset)).toEqual([2, 4]);
  });
});
