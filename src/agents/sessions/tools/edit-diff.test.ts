import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { prepareFileEdit, type Edit } from "./edit-diff.js";
import { prepareFileDiff } from "./file-diff.js";

function prepareChangedEdit(content: string, edits: Edit[], path: string) {
  const plan = prepareFileEdit(content, edits, path);
  if (!plan.changed) {
    throw new Error("Expected an edit plan that changes the file");
  }
  return plan;
}

function getMismatchMessage(content: string, edits: Edit[]): string {
  try {
    prepareFileEdit(content, edits, "test.ts");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected edit mismatch");
}

describe("applyEditsToNormalizedContent", () => {
  it("shows up to 3 best candidates sorted by similarity", () => {
    const message = getMismatchMessage(
      "function alpha() {}\nfunction beta() {}\nfunction bet() {}\nfunction delta() {}\n",
      [{ oldText: "function betaa() {}", newText: "" }],
    );

    expect(message.match(/near line/g)).toHaveLength(3);
    expect(message.indexOf("near line 2")).toBeLessThan(message.indexOf("near line 3"));
  });

  it("uses the most meaningful oldText line for multiline diagnostics", () => {
    const message = getMismatchMessage("header\nconst actualValue = 42;\nfooter\n", [
      { oldText: "x\nconst actualValue = 99;\n", newText: "" },
    ]);

    expect(message).toContain("near line 2");
    expect(message).toContain('expected: "const actualValue = 99;"');
  });

  it("calls out indentation differences", () => {
    const message = getMismatchMessage("      const value = 42;\n", [
      { oldText: "            const value = 42;", newText: "" },
    ]);

    expect(message).toContain("indentation differs (expected 12 spaces, found 6 spaces)");
  });

  it("calls out escaping differences", () => {
    const message = getMismatchMessage('const pattern = "\\bword\\b";\n', [
      { oldText: 'const pattern = "\\\\bword\\\\b";', newText: "" },
    ]);

    expect(message).toContain("escaping differs (expected 4 backslashes, found 2)");
  });

  it("omits candidates below the similarity threshold", () => {
    const message = getMismatchMessage("abc\nxyz\n123\n", [
      { oldText: "completely different text here", newText: "" },
    ]);

    expect(message).toContain("Could not find the exact text");
    expect(message).not.toContain("Closest matching lines");
  });

  it("does not split surrogate pairs at the displayed line boundary", () => {
    const message = getMismatchMessage(`${"x".repeat(119)}🙂found\n`, [
      { oldText: `${"x".repeat(119)}🙂expected`, newText: "" },
    ]);

    expect(message).toContain("Closest matching lines");
    expect(message).not.toContain("\\ud83d");
  });

  it("includes candidate hints for multi-edit failures", () => {
    const message = getMismatchMessage("alpha\nbeta\ngamma\n", [
      { oldText: "alpha", newText: "A" },
      { oldText: "bta", newText: "B" },
    ]);

    expect(message).toMatch(/Could not find edits\[1\][\s\S]*near line 2/);
  });
});

describe("prepareFileDiff", () => {
  it("separates distant hunks without displaying dependency EOF markers", () => {
    const oldContent = Array.from({ length: 10 }, (_, index) => String(index + 1)).join("\n");
    const newContent = oldContent.replace(/^2$/m, "TWO").replace(/^9$/m, "NINE");

    const result = prepareFileDiff("example.txt", oldContent, newContent, { context: 1 });
    expect(result).toMatchObject({
      diff: "  1 1\n- 2 2\n+ 2 TWO\n  3 3\n    ...\n  8 8\n- 9 9\n+ 9 NINE\n 10 10",
      firstChangedLine: 2,
    });
    if (!result) {
      throw new Error("Expected an unbounded diff receipt");
    }
    expect(applyPatch(oldContent, result.patch)).toBe(newContent);
  });
});

describe("applyEditsToNormalizedContent uniqueness", () => {
  it("replaces an exactly unique match when trailing whitespace makes a sibling line fuzzy-identical", () => {
    const content = "foo();  \nfoo();\nbar();\n";

    const result = prepareChangedEdit(
      content,
      [{ oldText: "foo();\n", newText: "baz();\n" }],
      "test.ts",
    );

    expect(result.content).toBe("foo();  \nbaz();\nbar();\n");
  });
});

describe("fuzzy edit source-span mapping", () => {
  it("rejects a match ending inside an NFKC expansion", () => {
    expect(() =>
      prepareChangedEdit("const value = \uFB01;\n", [{ oldText: "f", newText: "x" }], "test.ts"),
    ).toThrow(/ambiguous Unicode-normalization or trimmed-whitespace boundary/);
  });

  it("preserves trimmed bytes at EOF", () => {
    const result = prepareChangedEdit(
      "const value\u00A0= 1;  ",
      [{ oldText: "const value = 1;", newText: "const value = 2;" }],
      "test.ts",
    );

    expect(result.content).toBe("const value = 2;  ");
  });

  it("keeps trim-folding behavior inside a complete fuzzy span", () => {
    const result = prepareChangedEdit(
      "before\nfirst  \nsecond\nafter  \n",
      [{ oldText: "first\nsecond", newText: "combined" }],
      "test.ts",
    );

    expect(result.content).toBe("before\ncombined\nafter  \n");
  });

  it("preserves CRLF while mapping a fuzzy Unicode span", () => {
    const result = prepareChangedEdit(
      "const value\u00A0= 1;\r\nnext\r\n",
      [{ oldText: "const value = 1;", newText: "const value = 2;" }],
      "test.ts",
    );

    expect(result.content).toBe("const value = 2;\r\nnext\r\n");
  });

  it("keeps mixed replacements in original coordinates", () => {
    const edits = [
      { oldText: "const a = 1;", newText: "const a = 3;" },
      { oldText: "const b = 2;", newText: "const b = 4;" },
    ];
    const result = prepareChangedEdit("const a\u00A0= 1;\nconst b = 2;\n", edits, "test.ts");

    expect(result.content).toBe("const a = 3;\nconst b = 4;\n");
  });
});

describe("applyEditsToNormalizedContent fuzzy uniqueness", () => {
  it("still rejects a fuzzy match that is ambiguous once normalization is applied", () => {
    const content = "foo();  \nfoo();\t\nbar();\n";

    expect(() =>
      prepareChangedEdit(content, [{ oldText: "foo();\n", newText: "baz();\n" }], "test.ts"),
    ).toThrow(/Found 2 occurrences/);
  });
});
