// edit-diff tests cover not-found candidate hints and error diagnostics.
import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, normalizeToLF } from "./edit-diff.js";

describe("applyEditsToNormalizedContent", () => {
  it("includes near-match candidate hints when oldText is not found", () => {
    const content = normalizeToLF(
      "line one\n" +
        "this is a test line\n" +
        "another line here\n" +
        "const value = 42;\n" +
        "final line\n",
    );
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [{ oldText: "const value = 99;", newText: "" }],
        "test.ts",
      ),
    ).toThrow(/near line 4:[\s\S]*const value = 42[\s\S]*\d+% match/);
  });

  it("shows up to 3 best candidates sorted by similarity", () => {
    const content = normalizeToLF(
      "function alpha() {}\n" +
        "function beta() {}\n" +
        "function gamma() {}\n" +
        "function delta() {}\n",
    );
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [{ oldText: "function betaa() {}", newText: "" }],
        "test.ts",
      ),
    ).toThrow(/near line 2:[\s\S]*function beta/);
  });

  it("omits candidate hints when no line passes the similarity threshold", () => {
    const content = normalizeToLF("abc\nxyz\n123\n");
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [{ oldText: "completely different text here", newText: "" }],
        "test.ts",
      ),
    ).toThrow(/Could not find the exact text/);
    // The error should NOT contain candidate hint lines
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [{ oldText: "completely different text here", newText: "" }],
        "test.ts",
      ),
    ).not.toThrow(/near line/);
  });

  it("caps candidate scanning at MAX_LINES to avoid unbounded work", () => {
    // Generate content with many similar lines — should not OOM or hang.
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-const value = ${i}`);
    const content = normalizeToLF(lines.join("\n"));
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [{ oldText: "const value = 99999;", newText: "" }],
        "large.ts",
      ),
    ).toThrow(/Could not find/);
  });

  it("includes candidate hints for multi-edit failures", () => {
    const content = normalizeToLF("alpha\nbeta\ngamma\n");
    expect(() =>
      applyEditsToNormalizedContent(
        content,
        [
          { oldText: "alpha", newText: "A" },
          { oldText: "bta", newText: "B" },
        ],
        "test.ts",
      ),
    ).toThrow(/Could not find edits\[1\][\s\S]*near line 2:[\s\S]*beta/);
  });
});
