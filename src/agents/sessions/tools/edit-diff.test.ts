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
    // ClawSweeper regression: ﬁ (U+FB01) expands to "fi" (+1 char),
    // e+U+0301 composes to é (-1 char). Total length stays 6 but X
    // shifts from original offset 2 to normalized offset 3.
    //                           ^ ﬁ(1) (2) (3) e+acute(5) = 5 code units
    // NFKC:                   "fi X é"  = 5 code units
    // But wait — both are length 5 actually. The critical case is when
    // total char count is equal but internal positions shift.
    // ﬁ(1 char) + " " (1) + "X" (1) + " " (1) + é(1 char, 2 code units e+0301)
    // = 5 chars original, but é is 2 code units = 6 code units total
    // NFKC: fi(2) + " "(1) + X(1) + " "(1) + é(1 char, but é is precomposed = 1)
    // = 5 code units. Not equal length.
    // Use a case where length IS equal but positions shift:
    // U+FB01 (ﬁ, 1 code unit) → "fi" (2 code units) = +1
    // U+FB01 (ﬁ, 1 code unit) → "fi" (2 code units) = +1  (but we need -2)
    // Actually use: ﬁ(1) + X(1) + ﬁ(1) = 3 code units → fi(2) + X(1) + fi(2) = 5
    // Not equal. The real ClawSweeper example works with codepoints via Array.from:
    // "ﬁ X é" where é is precomposed (1 codepoint, 1 code unit) = 5 codepoints/codeunits
    // NFKC: "fi X é" = 5 codepoints/codeunits
    // X shifts from codepoint index 1 to 2.
    // However edit-diff operates on code unit (string index) offsets, not codepoints.
    // Since Array.from is used in the mapper, the mapping is codepoint-based.
    // Let me use the exact ClawSweeper example adapted for the tool's behavior.
    //
    // The key: if we have ﬁ(expands+1) + Y + é(composes -1) on the same line,
    // total length is preserved but Y's offset shifts.
    // In code unit terms: U+FB01(1) + Y(1) + e(1)+\u0301(1) = 4 code units
    // NFKC: fi(2) + Y(1) + é(1) = 4 code units. Y at offset 2 in both.
    // But codepoint-wise: Array.from gives [ﬁ, Y, e, ́] = 4 codepoints
    // NFKC segments: [fi, Y, é] = 3 segments, 4 codepoints
    // Y maps from codepoint 1 → 1 in both. Still no shift in this case.
    //
    // The actual shifting case in code units with Array.from:
    // ﬁ(1 cu, 1 cp) + space(1) + e(1)+\u0301(1) = 4 codepoints, 4 code units
    // NFKC: fi(2 cu, 1 cp as segment "fi") but Array.from("fi") = [f,i] = 2 codepoints
    // Hmm, the mapper works at codepoint level via Array.from segments.
    // With segment "ﬁ" → NFKC "fi" = 2 codepoints. Segment "e\u0301" → "é" = 1 codepoint.
    // So: segment [ﬁ] (1 cp) maps to 2 cps in NFKC. [e, ́] (2 cps) maps to [é] (1 cp).
    // Net: 3 original codepoints → 3 NFKC codepoints. Length equal.
    // But offsets within shift. If X is after ﬁ (cp index 1), in NFKC it's after "fi" (cp index 2).
    // This is the real case. Let me construct it:
    const line = "\uFB01 X e\u0301"; // ﬁ + space + X + space + e+combining-acute
    // Array.from: [ﬁ, " ", X, " ", e, ́] — wait, \u0301 is a combining mark
    // Actually the string is: U+FB01 U+0020 U+0058 U+0020 U+0065 U+0301
    // edit-diff's normalizeForFuzzyMatch does NFKC + smart quotes etc.
    // NFKC("\uFB01 X e\u0301") = "fi X é" (precomposed é)
    // Both are 5 code units? Let me verify:
    // Original: FB01(1) + 20(1) + 58(1) + 20(1) + 65(1) + 0301(1) = 6 code units, 6 codepoints
    // NFKC:     66(1) + 69(1) + 20(1) + 58(1) + 20(1) + E9(1) = 6 code units, 6 codepoints
    // But Array.from segments: [FB01][20][58][20][65+0301] = 5 segments, 6 codepoints
    // NFKC segments: [fi][20][58][20][é] = 5 segments, but fi=2cps, é=1cp
    // So: orig segments: [1cp][1cp][1cp][1cp][2cp] = 6cps total
    //      NFKC segments: [2cp][1cp][1cp][1cp][1cp] = 6cps total
    // X is in segment 2 (0-indexed) in both → offset 2 after segment 0 (ﬁ→fi = 1→2cps)
    // In orig: after segment 0 (1cp), X at cp 2. In NFKC: after segment 0 (2cps), X at cp 3.
    // Length check: 6 === 6 → old fast path would incorrectly return offset 2.
    // New fast path: "fi X é" !== "ﬁ X e\u0301" → runs the mapper correctly.

    // Fuzzy-match using the NFKC-normalized form (fi) which differs from original (ﬁ).
    // This forces the normalized-to-original offset mapper to run.
    const result = applyEditsToNormalizedContent(
      normalizeToLF(line),
      [{ oldText: "fi X", newText: "FI Y" }],
      "test.ts",
    );
    // After mapping the NFKC match back to original offsets, ﬁ and e+acute must be preserved.
    expect(result.newContent).toBe("\uFB01 Y e\u0301");
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
