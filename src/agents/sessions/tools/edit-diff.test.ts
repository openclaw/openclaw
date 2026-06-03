import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, normalizeToLF } from "./edit-diff.js";

describe("applyEditsToNormalizedContent", () => {
  it("exact match does not touch unrelated lines", () => {
    const content = 'line1   \nconst x = "hello";\nline3   ';
    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: 'const x = "hello";', newText: 'const x = "world";' }],
      "test.ts",
    );
    const lines = result.newContent.split("\n");
    expect(lines[0]).toBe("line1   ");
    expect(lines[1]).toBe('const x = "world";');
    expect(lines[2]).toBe("line3   ");
  });

  it("fuzzy match preserves trailing whitespace on unrelated lines", () => {
    const content = [
      "line1   ", // trailing spaces
      "const name = \u2018Bob\u2019;", // smart quotes (no wrapping ASCII quotes)
      "line3   ", // trailing spaces
    ].join("\n");

    // oldText uses ASCII quotes (triggers fuzzy matching)
    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "const name = \u0027Bob\u0027;", newText: "const name = 'Alice';" }],
      "test.ts",
    );

    const lines = result.newContent.split("\n");
    expect(lines[0]).toBe("line1   ");
    expect(lines[1]).toBe("const name = 'Alice';");
    expect(lines[2]).toBe("line3   ");
  });

  it("fuzzy match preserves Unicode characters on unrelated lines", () => {
    const content = [
      "const a = \u201Chello\u201D;", // smart double quotes
      "const b = 42;",
      "const c = \u201Cworld\u201D;", // smart double quotes
    ].join("\n");

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "const b = 42;", newText: "const b = 99;" }],
      "test.ts",
    );

    const lines = result.newContent.split("\n");
    expect(lines[0]).toBe("const a = \u201Chello\u201D;");
    expect(lines[1]).toBe("const b = 99;");
    expect(lines[2]).toBe("const c = \u201Cworld\u201D;");
  });

  it("fuzzy match preserves em dashes on unrelated lines", () => {
    const content = "const range = \u2014;\nconst val = \u2018x\u2019;";

    // Edit targets the second line via fuzzy match (smart quotes -> ASCII)
    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "const val = \u0027x\u0027;", newText: "const val = 'y';" }],
      "test.ts",
    );

    const lines = result.newContent.split("\n");
    expect(lines[0]).toBe("const range = \u2014;");
    expect(lines[1]).toBe("const val = 'y';");
  });

  it("fuzzy match with multi-line oldText preserves unrelated lines", () => {
    const content = [
      "header   ",
      "const a = \u2018one\u2019;",
      "const b = \u2018two\u2019;",
      "footer   ",
    ].join("\n");

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [
        {
          oldText: "const a = \u0027one\u0027;\nconst b = \u0027two\u0027;",
          newText: "const a = 'ONE';\nconst b = 'TWO';",
        },
      ],
      "test.ts",
    );

    const lines = result.newContent.split("\n");
    expect(lines[0]).toBe("header   ");
    expect(lines[1]).toBe("const a = 'ONE';");
    expect(lines[2]).toBe("const b = 'TWO';");
    expect(lines[3]).toBe("footer   ");
  });

  it("baseContent is always the original content", () => {
    const content = "line with smart\u2019s\nline with trailing   ";

    // The ASCII apostrophe triggers fuzzy matching against the smart apostrophe
    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "line with smart\u0027s", newText: "replaced" }],
      "test.ts",
    );

    expect(result.baseContent).toBe(normalizeToLF(content));
  });
});
