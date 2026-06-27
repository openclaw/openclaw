// Unit tests for the closest-line diagnostics used to explain edit-tool mismatches.
import { describe, expect, it } from "vitest";
import { describeClosestLines, findClosestLines } from "./edit-diff.js";

describe("findClosestLines", () => {
  it("flags a whitespace-only (indentation) difference as the closest line", () => {
    const content = "function f() {\n        return foo();\n}\n";
    const [closest] = findClosestLines(content, "    return foo();");
    expect(closest).toMatchObject({
      lineNumber: 2,
      distance: 0,
      note: "indentation differs: expected 4 spaces, found 8 spaces",
    });
  });

  it("surfaces a near-miss content difference (escaped vs literal)", () => {
    const content = "const re = /\\b/;\nconst other = 1;\n";
    const [closest] = findClosestLines(content, "const re = /\b/;");
    expect(closest.lineNumber).toBe(1);
    expect(closest.distance).toBeGreaterThan(0);
    expect(closest.note).toBe("content differs");
  });

  it("returns nothing when no line is reasonably close", () => {
    expect(findClosestLines("actual current content", "missing")).toEqual([]);
  });

  it("ignores blank lines and respects the candidate cap", () => {
    const content = "return x;\n\n\nreturn x;\nreturn x;\nreturn x;\n";
    const result = findClosestLines(content, "  return x;", 2);
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("describes tab indentation distinctly from spaces", () => {
    const [closest] = findClosestLines("\t\treturn foo();\n", "    return foo();");
    expect(closest.note).toBe("indentation differs: expected 4 spaces, found 2 tabs");
  });
});

describe("describeClosestLines", () => {
  it("JSON-escapes candidate text so whitespace is visible, or returns empty", () => {
    const block = describeClosestLines("        return foo();\n", "    return foo();");
    expect(block).toContain("Closest line(s) to your oldText");
    expect(block).toContain('"        return foo();"');
    expect(describeClosestLines("totally unrelated", "missing")).toBe("");
  });
});
