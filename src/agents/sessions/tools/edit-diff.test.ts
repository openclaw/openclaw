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

  it("fuzzy match preserves NFKC ligature when it appears before the match on the same line", () => {
    // U+FB03 (ﬃ) expands to "ffi" under NFKC (1 char -> 3 chars).
    // A smart-quote fuzzy match AFTER the ligature must not shift the
    // replacement position by the 2-char NFKC expansion delta.
    const content = "const \uFB03ce = \u2018val\u2019;";
    //                      ^ ﬃ ligature    ^ smart quotes trigger fuzzy match

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "const \uFB03ce = 'val';", newText: "const \uFB03ce = 'new';" }],
      "test.ts",
    );

    // The ﬃ ligature must survive intact; only the smart quotes change.
    expect(result.newContent).toBe("const \uFB03ce = 'new';");
  });

  it("fuzzy match with NFKC-expanding character and multi-char expansion", () => {
    // U+FB01 (ﬁ) expands to "fi" under NFKC (1 char -> 2 chars).
    // Two expansions on the same line compound the offset shift.
    const content = "\uFB01nd \uFB03x = \u201Chello\u201D;";
    //               ^ ﬁ      ^ ﬃ        ^ smart double quotes

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: '\uFB01nd \uFB03x = "hello";', newText: '\uFB01nd \uFB03x = "world";' }],
      "test.ts",
    );

    expect(result.newContent).toBe('\uFB01nd \uFB03x = "world";');
  });

  it("fuzzy match preserves decomposed combining characters before the match", () => {
    // e + U+0301 (combining acute accent) composes to é under NFKC (2 chars -> 1 char).
    // A smart-quote fuzzy match AFTER the combining sequence must not
    // miscalculate the replacement position due to NFKC composition.
    const content = "const caf\u0065\u0301 = \u2018latte\u2019;";
    //                         ^ e + combining acute    ^ smart quotes

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [
        {
          oldText: "const caf\u0065\u0301 = 'latte';",
          newText: "const caf\u0065\u0301 = 'mocha';",
        },
      ],
      "test.ts",
    );

    // The decomposed e + combining acute must survive; only the smart quotes change.
    expect(result.newContent).toBe("const caf\u0065\u0301 = 'mocha';");
  });

  it("fuzzy match replaces NFKC ligature when oldText matches part of its expansion", () => {
    // U+FB03 (ﬃ) expands to "ffi" under NFKC. oldText "ff" matches the first
    // two chars of the expansion. The mapper must produce a nonzero original
    // range covering the whole ligature, not a zero-length splice that inserts
    // text before the original character without removing it.
    const content = "const x = \uFB03;";

    const result = applyEditsToNormalizedContent(
      normalizeToLF(content),
      [{ oldText: "const x = ff", newText: "const x = ZZ" }],
      "test.ts",
    );

    // The ﬃ ligature must be consumed (replaced), not left behind.
    // The whole ligature is replaced because you cannot partially edit a
    // single character; the trailing "i" from the NFKC expansion is lost.
    expect(result.newContent).toBe("const x = ZZ;");
  });

  it("fuzzy match with length-neutral NFKC (mixed expansion + composition)", () => {
    // ﬁ (U+FB01) expands to "fi" under NFKC (+1 codepoint),
    // e+U+0301 composes to é (-1 codepoint). Total codepoint count is
    // preserved but internal positions shift.
    //
    // Original:  [ﬁ][ ][X]['][e+\u0301]  = 5 segments, 6 codepoints
    // NFKC:      [fi][ ][X]['][é]       = 5 segments, 6 codepoints
    // X is at codepoint offset 2 in original, 3 in NFKC.
    // A length-equality-only fast path would incorrectly use offset 2.
    // The segment mapper correctly handles the shift.
    //
    // Use smart quotes (') around X to force the fuzzy-match path while
    // keeping the match region AFTER the ligature, so ﬁ is unrelated content
    // that must be preserved.
    const line = "\uFB01 \u2018X\u2019 e\u0301"; // ﬁ + smart-quotes X + e+combining-acute

    const result = applyEditsToNormalizedContent(
      normalizeToLF(line),
      [{ oldText: "'X'", newText: "'Y'" }],
      "test.ts",
    );
    // After mapping the NFKC match back to original offsets, ﬁ and e+acute must be preserved.
    expect(result.newContent).toBe("\uFB01 \u2018Y\u2019 e\u0301");
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
