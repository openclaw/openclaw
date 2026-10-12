import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "./cjk-chars.js";

describe("normalization-core/cjk-chars", () => {
  it("weights fullwidth punctuation with Latin text", () => {
    expect(estimateStringChars("hello，world")).toBe(14);
  });

  it("rounds weighted characters up to whole tokens", () => {
    expect(estimateTokensFromChars(9)).toBe(3);
  });

  it("covers CJK script-extension marks with measured weights", () => {
    expect(estimateStringChars("·".repeat(32))).toBe(32 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars(String.fromCodePoint(0x02ca))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xa700))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0x1d360))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
  });

  it.each([
    ["\ud800\ud800\udc00", 3],
    ["a你\u1100\uFF61\u{1D360}\u{20000}😀", 55],
  ])("keeps repeated estimates stable for %j", (text, expected) => {
    expect([text, "ascii", text, "", text].map(estimateStringChars)).toEqual([
      expected,
      5,
      expected,
      0,
      expected,
    ]);
  });
});
