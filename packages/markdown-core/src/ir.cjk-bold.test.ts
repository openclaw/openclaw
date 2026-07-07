import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("CJK-friendly emphasis parsing", () => {
  it("parses bold with CJK punctuation inside closing **", () => {
    const ir = markdownToIR("**标题：**正文");
    expect(ir.text).toBe("标题：正文");
    expect(ir.styles).toEqual([{ start: 0, end: 3, style: "bold" }]);
  });

  it("parses bold with fullwidth colon inside closing **", () => {
    const ir = markdownToIR("**粗体：**内容");
    expect(ir.styles).toEqual([{ start: 0, end: 3, style: "bold" }]);
  });

  it("parses bold with CJK period inside closing **", () => {
    const ir = markdownToIR("**标签。**后续");
    expect(ir.styles).toEqual([{ start: 0, end: 3, style: "bold" }]);
  });

  it("parses multiple CJK bold spans", () => {
    const ir = markdownToIR("边界：**社区显示：**Fable 与 **有效**。");
    expect(ir.styles).toEqual([
      { start: 3, end: 8, style: "bold" },
      { start: 16, end: 18, style: "bold" },
    ]);
  });

  it("does not parse bold when delimiter is next to whitespace", () => {
    // Whitespace before closing ** must still block emphasis.
    const ir = markdownToIR("**标题： **正文");
    expect(ir.styles.filter((s) => s.style === "bold")).toEqual([]);
  });

  it("does not parse bold with leading whitespace after opening **", () => {
    const ir = markdownToIR("** 标题：**正文");
    expect(ir.styles.filter((s) => s.style === "bold")).toEqual([]);
  });

  it("non-CJK bold still works", () => {
    const ir = markdownToIR("**hello** world");
    expect(ir.styles).toEqual([{ start: 0, end: 5, style: "bold" }]);
  });

  it("non-CJK italic still works", () => {
    const ir = markdownToIR("*italic* and **bold**");
    expect(ir.styles).toEqual([
      { start: 0, end: 6, style: "italic" },
      { start: 11, end: 15, style: "bold" },
    ]);
  });

  it("does not parse bold adjacent to U+3000 ideographic space", () => {
    // U+3000 ideographic space before closing ** must block emphasis
    const ir = markdownToIR("**标题：　**正文");
    expect(ir.styles.filter((s) => s.style === "bold")).toEqual([]);
  });

  it("does not parse bold with U+2002 en space before closing **", () => {
    const ir = markdownToIR("**标题： **正文");
    expect(ir.styles.filter((s) => s.style === "bold")).toEqual([]);
  });
});
