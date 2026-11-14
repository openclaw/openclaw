import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { prepareFileEdit, type Edit } from "./edit-diff.js";
import { prepareFileDiff } from "./file-diff.js";

function prepareChangedEdit(content: string, edits: Edit[]) {
  const plan = prepareFileEdit(content, edits, "test.ts");
  if (!plan.changed) {
    throw new Error("Expected an edit plan that changes the file");
  }
  return plan;
}

function getMismatchMessage(content: string, edit: string | Edit[]): string {
  try {
    prepareFileEdit(
      content,
      typeof edit === "string" ? [{ oldText: edit, newText: "" }] : edit,
      "test.ts",
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected edit mismatch");
}

describe("applyEditsToNormalizedContent", () => {
  it("shows the closest matching line with expected, found, and difference marker", () => {
    const message = getMismatchMessage(
      "line one\nthis is a test line\nanother line here\nconst value = 42;\nfinal line\n",
      "const value = 99;",
    );

    expect(message).toMatch(/near line 4 \(\d+% match\)/);
    expect(message).toContain('expected: "const value = 99;"');
    expect(message).toContain('found:    "const value = 42;"');
    expect(message).toMatch(/\^{1,12}/);
  });

  it("shows up to 3 best candidates sorted by similarity", () => {
    const message = getMismatchMessage(
      "function alpha() {}\nfunction beta() {}\nfunction bet() {}\nfunction delta() {}\n",
      "function betaa() {}",
    );

    expect(message.match(/near line/g)).toHaveLength(3);
    expect(message.indexOf("near line 2")).toBeLessThan(message.indexOf("near line 3"));
  });

  it("uses the most meaningful oldText line for multiline diagnostics", () => {
    const message = getMismatchMessage(
      "header\nconst actualValue = 42;\nfooter\n",
      "x\nconst actualValue = 99;\n",
    );

    expect(message).toContain("near line 2");
    expect(message).toContain('expected: "const actualValue = 99;"');
  });

  it.each([
    [
      "      const value = 42;\n",
      "            const value = 42;",
      "indentation differs (expected 12 spaces, found 6 spaces)",
    ],
    [
      'const pattern = "\\bword\\b";\n',
      'const pattern = "\\\\bword\\\\b";',
      "escaping differs (expected 4 backslashes, found 2)",
    ],
  ])("explains diagnostic differences in %j", (content, oldText, expected) => {
    expect(getMismatchMessage(content, oldText)).toContain(expected);
  });

  it("omits candidates below the similarity threshold", () => {
    const message = getMismatchMessage("abc\nxyz\n123\n", "completely different text here");

    expect(message).toContain("Could not find the exact text");
    expect(message).not.toContain("Closest matching lines");
  });

  it("bounds candidate scanning and displayed line length", () => {
    const content = `${Array.from({ length: 1000 }, () => "unrelated").join("\n")}\n${"x".repeat(
      200_000,
    )}const value = 42;`;
    const message = getMismatchMessage(content, "const value = 99;");

    expect(message).not.toContain("const value = 42");
    expect(message.length).toBeLessThan(1000);
  });

  it("does not split surrogate pairs at the displayed line boundary", () => {
    const message = getMismatchMessage(
      `${"x".repeat(119)}🙂found\n`,
      `${"x".repeat(119)}🙂expected`,
    );

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
  it.each([
    [
      "first\nthird\nfourth\n",
      "first\nsecond\nthird\nfourth\n",
      " 1 first\n+2 second\n 3 third\n 4 fourth",
    ],
    [
      "first\nsecond\nthird\nfourth\n",
      "first\nthird\nfourth\n",
      " 1 first\n-2 second\n 2 third\n 3 fourth",
    ],
  ])("numbers context after changing %j to %j", (original, content, diff) => {
    expect(prepareFileDiff("example.txt", original, content, { context: 2 })).toMatchObject({
      diff,
      firstChangedLine: 2,
    });
  });

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

    const result = prepareChangedEdit(content, [{ oldText: "foo();\n", newText: "baz();\n" }]);

    expect(result.content).toBe("foo();  \nbaz();\nbar();\n");
  });
});

describe("fuzzy edit source-span mapping", () => {
  it.each<[string, string, string, string]>([
    [
      "label = “hello”; // “comment” — unchanged\n",
      'label = "hello";',
      "label = 'hi';",
      "label = 'hi'; // “comment” — unchanged\n",
    ],
    ["value = \uFB01;\n", "fi", "pair", "value = pair;\n"],
    ["cafe\u0301 = 1; // 🙂\n", "café = 1;", "cafe = 2;", "cafe = 2; // 🙂\n"],
    ["value\u00A0= 1;  ", "value = 1;", "value = 2;", "value = 2;  "],
    ["value\u00A0= 1;\r\nnext\r\n", "value = 1;", "value = 2;", "value = 2;\r\nnext\r\n"],
  ])("maps fuzzy source spans in %j", (content, oldText, newText, expected) => {
    expect(prepareChangedEdit(content, [{ oldText, newText }]).content).toBe(expected);
  });

  it("rejects a match ending inside an NFKC expansion", () => {
    expect(() =>
      prepareChangedEdit("const value = \uFB01;\n", [{ oldText: "f", newText: "x" }]),
    ).toThrow(/ambiguous Unicode-normalization or trimmed-whitespace boundary/);
  });

  it.each(["fuzzy first", "exact first"])(
    "keeps mixed replacements in original coordinates with %s",
    (order) => {
      const edits = [
        { oldText: "const a = 1;", newText: "const a = 3;" },
        { oldText: "const b = 2;", newText: "const b = 4;" },
      ];
      const result = prepareChangedEdit(
        "const a\u00A0= 1;\nconst b = 2;\n",
        order === "exact first" ? edits.toReversed() : edits,
      );

      expect(result.content).toBe("const a = 3;\nconst b = 4;\n");
    },
  );
});

describe("applyEditsToNormalizedContent fuzzy uniqueness", () => {
  it("still rejects a fuzzy match that is ambiguous once normalization is applied", () => {
    const content = "foo();  \nfoo();\t\nbar();\n";

    expect(() =>
      prepareChangedEdit(content, [{ oldText: "foo();\n", newText: "baz();\n" }]),
    ).toThrow(/Found 2 occurrences/);
  });

  it.each([
    ["a();\na();\na();\n", "a();\na();", "b();"],
    ["a();\na(); \na();\n", "a();\na();\n", "b();\n"],
  ])("rejects overlapping occurrences in %j", (content, oldText, newText) => {
    expect(() => prepareFileEdit(content, [{ oldText, newText }], "test.ts")).toThrow(
      /Found 2 occurrences/,
    );
  });
});
