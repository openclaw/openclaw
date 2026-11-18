import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateStringTokenPressure,
  estimateTokensFromChars,
} from "./cjk-chars.js";

describe("normalization-core/cjk-chars", () => {
  it("keeps Latin text on the regular chars-per-token heuristic", () => {
    expect(estimateStringChars("")).toBe(0);
    expect(estimateStringChars("hello world")).toBe(11);
  });

  it("weights common CJK text as roughly one token per character", () => {
    expect(estimateStringChars("\u4F60\u597D\u4E16\u754C")).toBe(4 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars("hi\u4F60\u597D")).toBe(10);
  });

  it.each([
    ["hiragana", "こんにちは", 20],
    ["Hangul", "안녕하세요", 20],
    ["fullwidth letters and numbers", "ＡＢＣ１２３", 24],
    ["fullwidth punctuation with Latin text", "hello，world", 14],
  ])("weights %s", (_label, text, expected) => {
    expect(estimateStringChars(text)).toBe(expected);
  });

  it.each([
    [8, 2],
    [9, 3],
    [0, 0],
    [-10, 0],
  ])("estimates %s weighted characters as %s tokens", (chars, expected) => {
    expect(estimateTokensFromChars(chars)).toBe(expected);
  });

  it("uses measured weights for halfwidth and supplementary CJK", () => {
    expect(estimateStringChars("ｺﾝﾆﾁﾊ")).toBe(5 * CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xffa1))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0x20000))).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
    expect(estimateStringChars(String.fromCodePoint(0x30000))).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
  });

  it("weights decomposed Hangul and compatibility forms", () => {
    const decomposedHangul = "안녕하세요".normalize("NFD");
    expect(estimateStringChars(decomposedHangul)).toBe(
      decomposedHangul.length * CHARS_PER_TOKEN_ESTIMATE * 3,
    );
    expect(estimateStringChars(String.fromCodePoint(0xa960))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0xd7b0))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0xfe10))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xffe0))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
  });

  it.each([0x2e80, 0x3400, 0x9fff, 0xa000, 0xf900])(
    "uses a conservative rare-BMP weight for U+%s",
    (codePoint) => {
      expect(estimateStringChars(String.fromCodePoint(codePoint))).toBe(
        CHARS_PER_TOKEN_ESTIMATE * 3,
      );
    },
  );

  it.each([0x16fe3, 0x1aff0, 0x1b001, 0x1f200, 0x17000, 0x18800, 0x18b00, 0x1b170, 0x1b2ff])(
    "uses a conservative supplementary-CJK weight for U+%s",
    (cp) => {
      expect(estimateStringChars(String.fromCodePoint(cp))).toBe(CHARS_PER_TOKEN_ESTIMATE * 4);
    },
  );

  it("covers CJK script-extension marks with measured weights", () => {
    expect(estimateStringChars("·".repeat(32))).toBe(32 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateStringChars(String.fromCodePoint(0x02ca))).toBe(CHARS_PER_TOKEN_ESTIMATE * 2);
    expect(estimateStringChars(String.fromCodePoint(0xa700))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
    expect(estimateStringChars(String.fromCodePoint(0x1d360))).toBe(CHARS_PER_TOKEN_ESTIMATE * 3);
  });

  it("does not collapse non-CJK surrogate pairs", () => {
    expect(estimateStringChars("\uD83D\uDE00")).toBe(2);
  });

  it.each([
    ["\ud800a\udfff", 3],
    ["\u{20000}\u{20000}", 32],
    ["\u{3347F}\u{33480}\u{10FFFF}", 20],
    ["\ud800\ud800\udc00", 3],
    ["\u9FA5\u9FA6", 16],
    ["a你\u1100\uFF61\u{1D360}\u{20000}\u{18D00}😀", 71],
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

// Captured from the pre-scan estimator; preserve its rounding and regex precedence.
it("preserves token-pressure estimates across a deterministic lexical corpus", () => {
  const corpus = [
    "",
    "{}[]:,",
    "abc123 x123 123x _123 123_ +123-456/789=",
    "a".repeat(15),
    "a".repeat(16),
    "a".repeat(63),
    "a".repeat(64),
    "9".repeat(80),
    "a1".repeat(8),
    "+/=_-".repeat(20),
    "你123한456😀789\ud80012",
    JSON.stringify({ rows: [{ id: 123456789, hash: "abcdef0123456789", values: [1, 2, 3] }] }),
  ];
  let seed = 721;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = "ABCXYZabcxyz019+/_=-{}[]:, .\n你한😀\ud800";
  for (let i = 0; i < 2048; i++) {
    let text = "";
    const size = next() % 300;
    for (let j = 0; j < size; j++) {
      text += alphabet[next() % alphabet.length];
    }
    if (i % 3 === 0) {
      text += "ab12+/=_-".repeat(next() % 20);
    }
    corpus.push(text);
  }
  const hash = createHash("sha256");
  for (const text of corpus) {
    for (const ratio of [1, 2, 3, 4, 7, 1.1, 3.3]) {
      hash.update(`${estimateStringTokenPressure(text, ratio)},`);
    }
  }
  expect(hash.digest("hex")).toBe(
    "3ce61d6d6c098f147b547bd13dc5d2a3861eb97782ad9a684e87fb5fb7aa49c4",
  );
});
