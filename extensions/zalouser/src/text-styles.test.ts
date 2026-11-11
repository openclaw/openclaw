import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles", () => {
  it("preserves leading blank lines and shifts ranges", () => {
    expect(parseZalouserTextStyles("\n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles("x\n  \n")).toEqual({ text: "x\n\n", styles: [] });
    expect(parseZalouserTextStyles("x\n  ")).toEqual({ text: "x\n", styles: [] });
    expect(parseZalouserTextStyles(">\n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles(">   \n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
  });

  it("keeps inline code and plain math markers literal", () => {
    expect(parseZalouserTextStyles("before `inline *code*` after\n2 * 3 * 4")).toEqual({
      text: "before `inline *code*` after\n2 * 3 * 4",
      styles: [],
    });
    expect(parseZalouserTextStyles("`*x`")).toEqual({ text: "`*x`", styles: [] });
    expect(parseZalouserTextStyles("***bold**")).toEqual({
      text: "*bold",
      styles: [{ start: 1, len: 4, st: TextStyle.Bold }],
    });
  });

  it.each([
    ["code after an escaped backtick", "\\` `*x*`", "` `*x*`"],
    ["HTML entities resembling projection sentinels", "&#xE000;", "&#xE000;"],
    ["unsupported escapes", "\\[literal]", "\\[literal]"],
    ["hard-break syntax", "line\\\nnext  ", "line\\\nnext  "],
    ["backslash before trailing whitespace", "line\\  ", "line\\  "],
  ])("keeps local literal bytes for %s", (_name, input, text) => {
    expect(parseZalouserTextStyles(input)).toEqual({ text, styles: [] });
  });

  it("keeps emphasis flanking next to protected inline code", () => {
    expect(parseZalouserTextStyles("_foo_`bar`")).toEqual({
      text: "foo`bar`",
      styles: [{ start: 0, len: 3, st: TextStyle.Italic }],
    });
    expect(parseZalouserTextStyles("__foo_bar__")).toEqual({
      text: "foo_bar",
      styles: [{ start: 0, len: 7, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles("_x_*")).toEqual({
      text: "x*",
      styles: [{ start: 0, len: 1, st: TextStyle.Italic }],
    });
    expect(parseZalouserTextStyles("*a**b*")).toEqual({
      text: "a**b",
      styles: [{ start: 0, len: 4, st: TextStyle.Italic }],
    });
    expect(parseZalouserTextStyles("*a***b")).toEqual({
      text: "a**b",
      styles: [{ start: 0, len: 1, st: TextStyle.Italic }],
    });
  });

  it("keeps link syntax literal while styling its label", () => {
    expect(parseZalouserTextStyles("[**label**](https://example.com)")).toEqual({
      text: "[label](https://example.com)",
      styles: [{ start: 1, len: 5, st: TextStyle.Bold }],
    });
  });
});
