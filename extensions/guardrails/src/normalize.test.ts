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
    ["U+00AD soft hyphen", "bad­word"],
    ["U+200B zero-width space", "bad​word"],
    ["U+200C zero-width non-joiner", "bad‌word"],
    ["U+200D zero-width joiner", "bad‍word"],
    ["U+200E left-to-right mark", "bad‎word"],
    ["U+200F right-to-left mark", "bad‏word"],
    ["U+202A left-to-right embedding", "bad‪word"],
    ["U+202B right-to-left embedding", "bad‫word"],
    ["U+202C pop directional formatting", "bad‬word"],
    ["U+202D left-to-right override", "bad‭word"],
    ["U+202E right-to-left override", "bad‮word"],
    ["U+2060 word joiner", "bad⁠word"],
    ["U+2066 left-to-right isolate", "bad⁦word"],
    ["U+2067 right-to-left isolate", "bad⁧word"],
    ["U+2068 first strong isolate", "bad⁨word"],
    ["U+2069 pop directional isolate", "bad⁩word"],
    ["U+115F hangul choseong filler", "badᅟword"],
    ["U+1160 hangul jungseong filler", "badᅠword"],
    ["U+FEFF BOM", "﻿badword"],
  ])("removes %s", (_name, input) => {
    expect(normalizeText(input)).toBe("badword");
  });

  it("removes multiple zero-width chars between every character", () => {
    expect(normalizeText("b​a​d​w​o​r​d")).toBe("badword");
  });

  it("handles combined fullwidth + zero-width bypass", () => {
    expect(normalizeText("ｂａｄ​ｗｏｒｄ")).toBe("badword");
  });

  it("normalizes NFC: NFD input → NFC output matches NFC keyword", () => {
    const nfd = "étude"; // é as NFD
    const nfc = "étude"; // é as NFC
    expect(normalizeText(nfd)).toBe(normalizeText(nfc));
  });

  it("does not affect Chinese characters", () => {
    expect(normalizeText("敏感词")).toBe("敏感词");
  });

  it("handles empty string", () => {
    expect(normalizeText("")).toBe("");
  });
});
