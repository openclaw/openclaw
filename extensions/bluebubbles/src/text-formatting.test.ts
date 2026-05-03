import { describe, expect, it } from "vitest";
import { extractTextFormatting } from "./text-formatting.js";

describe("extractTextFormatting", () => {
  it("handles empty input", () => {
    expect(extractTextFormatting("")).toEqual({ plain: "", formatting: [] });
  });

  it("returns plain text when no markers are present", () => {
    expect(extractTextFormatting("hello world")).toEqual({
      plain: "hello world",
      formatting: [],
    });
  });

  it("extracts a single bold range", () => {
    const out = extractTextFormatting("hello **world**");
    expect(out.plain).toBe("hello world");
    expect(out.formatting).toEqual([{ start: 6, length: 5, styles: ["bold"] }]);
  });

  it("treats __X__ as bold", () => {
    const out = extractTextFormatting("__loud__");
    expect(out.plain).toBe("loud");
    expect(out.formatting).toEqual([{ start: 0, length: 4, styles: ["bold"] }]);
  });

  it("extracts italic with single asterisks", () => {
    const out = extractTextFormatting("*soft* spoken");
    expect(out.plain).toBe("soft spoken");
    expect(out.formatting).toEqual([{ start: 0, length: 4, styles: ["italic"] }]);
  });

  it("does not treat underscores inside identifiers as italic", () => {
    const out = extractTextFormatting("snake_case_name");
    expect(out.plain).toBe("snake_case_name");
    expect(out.formatting).toEqual([]);
  });

  it("extracts strikethrough", () => {
    const out = extractTextFormatting("price: ~~10~~ 5");
    expect(out.plain).toBe("price: 10 5");
    expect(out.formatting).toEqual([{ start: 7, length: 2, styles: ["strikethrough"] }]);
  });

  it("merges nested bold + italic into a single multi-style range", () => {
    const out = extractTextFormatting("**_both_**");
    expect(out.plain).toBe("both");
    expect(out.formatting).toEqual([{ start: 0, length: 4, styles: ["italic", "bold"] }]);
  });

  it("handles mixed sequential markers", () => {
    const out = extractTextFormatting("**a** then *b*");
    expect(out.plain).toBe("a then b");
    expect(out.formatting).toEqual([
      { start: 0, length: 1, styles: ["bold"] },
      { start: 7, length: 1, styles: ["italic"] },
    ]);
  });

  it("falls back to literal when markers are unbalanced", () => {
    const out = extractTextFormatting("hello **world");
    expect(out.plain).toBe("hello **world");
    expect(out.formatting).toEqual([]);
  });

  it("bails out when block-level markdown is present", () => {
    const out = extractTextFormatting("# heading\n**bold**");
    expect(out.plain).toBe("# heading\n**bold**");
    expect(out.formatting).toEqual([]);
  });

  it("ranges align to the stripped message body", () => {
    const out = extractTextFormatting("the **quick** brown ~~fox~~");
    expect(out.plain).toBe("the quick brown fox");
    for (const r of out.formatting) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.start + r.length).toBeLessThanOrEqual(out.plain.length);
    }
  });
});
