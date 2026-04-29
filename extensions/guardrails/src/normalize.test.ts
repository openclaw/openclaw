import { describe, expect, it } from "vitest";
import { normalizeText } from "./normalize.js";

describe("normalizeText", () => {
  it("returns plain ASCII unchanged", () => {
    expect(normalizeText("hello world")).toBe("hello world");
  });

  it("lowercases by default", () => {
    expect(normalizeText("BADWORD")).toBe("badword");
    expect(normalizeText("BaDwOrD")).toBe("badword");
  });

  it("preserves case when caseSensitive=true", () => {
    expect(normalizeText("BADWORD", true)).toBe("BADWORD");
  });

  it("converts fullwidth to halfwidth (letters, digits, symbols)", () => {
    expect(normalizeText("ｂａｄｗｏｒｄ")).toBe("badword");
    expect(normalizeText("ＢＡＤＷＯＲＤ")).toBe("badword");
    expect(normalizeText("ｂａｄ１２３")).toBe("bad123");
    expect(normalizeText("ｂａｄ！ｗｏｒｄ")).toBe("bad!word");
  });

  it.each([
    ["U+200B zero-width space", "bad\u200Bword"],
    ["U+200C zero-width non-joiner", "bad\u200Cword"],
    ["U+200D zero-width joiner", "bad\u200Dword"],
    ["U+FEFF BOM", "\uFEFFbadword"],
    ["U+2060 word joiner", "bad\u2060word"],
  ])("removes %s", (_name, input) => {
    expect(normalizeText(input)).toBe("badword");
  });

  it("removes multiple zero-width chars between every character", () => {
    expect(normalizeText("b\u200Ba\u200Bd\u200Bw\u200Bo\u200Br\u200Bd")).toBe("badword");
  });

  it("handles combined fullwidth + zero-width bypass", () => {
    expect(normalizeText("ｂａｄ\u200Bｗｏｒｄ")).toBe("badword");
  });

  it("normalizes NFC: NFD input → NFC output matches NFC keyword", () => {
    const nfd = "e\u0301tude"; // é as NFD
    const nfc = "\u00e9tude"; // é as NFC
    expect(normalizeText(nfd)).toBe(normalizeText(nfc));
  });

  it("does not affect Chinese characters", () => {
    expect(normalizeText("敏感词")).toBe("敏感词");
  });

  it("handles empty string", () => {
    expect(normalizeText("")).toBe("");
  });
});
