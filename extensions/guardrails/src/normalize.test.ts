import { describe, expect, it } from "vitest";
import { normalizeText } from "./normalize.js";

function cp(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

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
    ["U+00AD soft hyphen", `bad${cp(0x00ad)}word`],
    ["U+200B zero-width space", `bad${cp(0x200b)}word`],
    ["U+200C zero-width non-joiner", `bad${cp(0x200c)}word`],
    ["U+200D zero-width joiner", `bad${cp(0x200d)}word`],
    ["U+200E left-to-right mark", `bad${cp(0x200e)}word`],
    ["U+200F right-to-left mark", `bad${cp(0x200f)}word`],
    ["U+202A left-to-right embedding", `bad${cp(0x202a)}word`],
    ["U+202B right-to-left embedding", `bad${cp(0x202b)}word`],
    ["U+202C pop directional formatting", `bad${cp(0x202c)}word`],
    ["U+202D left-to-right override", `bad${cp(0x202d)}word`],
    ["U+202E right-to-left override", `bad${cp(0x202e)}word`],
    ["U+2060 word joiner", `bad${cp(0x2060)}word`],
    ["U+2066 left-to-right isolate", `bad${cp(0x2066)}word`],
    ["U+2067 right-to-left isolate", `bad${cp(0x2067)}word`],
    ["U+2068 first strong isolate", `bad${cp(0x2068)}word`],
    ["U+2069 pop directional isolate", `bad${cp(0x2069)}word`],
    ["U+115F hangul choseong filler", `bad${cp(0x115f)}word`],
    ["U+1160 hangul jungseong filler", `bad${cp(0x1160)}word`],
    ["U+FEFF BOM", `${cp(0xfeff)}badword`],
  ])("removes %s", (_name, input) => {
    expect(normalizeText(input)).toBe("badword");
  });

  it("removes multiple zero-width chars between every character", () => {
    expect(
      normalizeText(
        `b${cp(0x200b)}a${cp(0x200b)}d${cp(0x200b)}w${cp(0x200b)}o${cp(0x200b)}r${cp(0x200b)}d`,
      ),
    ).toBe("badword");
  });

  it("handles combined fullwidth + zero-width bypass", () => {
    expect(normalizeText(`ｂａｄ${cp(0x200b)}ｗｏｒｄ`)).toBe("badword");
  });

  it("normalizes NFC: NFD input → NFC output matches NFC keyword", () => {
    const nfd = "étude";
    const nfc = "étude";
    expect(normalizeText(nfd)).toBe(normalizeText(nfc));
  });

  it("does not affect Chinese characters", () => {
    expect(normalizeText("敏感词")).toBe("敏感词");
  });

  it("handles empty string", () => {
    expect(normalizeText("")).toBe("");
  });

  it("removes additional default ignorable characters covered by Unicode property escapes", () => {
    expect(normalizeText(`bad${cp(0x2061)}word`)).toBe("badword");
    expect(normalizeText(`bad${cp(0x2062)}word`)).toBe("badword");
    expect(normalizeText(`bad${cp(0x034f)}word`)).toBe("badword");
  });
});
