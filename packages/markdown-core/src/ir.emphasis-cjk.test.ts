// Markdown Core tests cover CJK-friendly emphasis flanking.
import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

function styledText(markdown: string, style: "bold" | "italic" = "bold"): string[] {
  const ir = markdownToIR(markdown);
  return ir.styles
    .filter((span) => span.style === style)
    .map((span) => ir.text.slice(span.start, span.end));
}

describe("markdownToIR CJK emphasis flanking", () => {
  it("closes strong emphasis before adjacent Chinese text", () => {
    expect(styledText("前**加粗：**后")).toEqual(["加粗："]);
  });

  it("closes strong emphasis before adjacent Japanese text", () => {
    expect(styledText("これは**強調。**です")).toEqual(["強調。"]);
  });

  it("closes strong emphasis before adjacent Korean text", () => {
    expect(styledText("이것은 **강조:**입니다")).toEqual(["강조:"]);
  });

  it("keeps ASCII CommonMark emphasis behavior", () => {
    expect(styledText("**bold** text")).toEqual(["bold"]);
    expect(styledText("foo**bar**baz")).toEqual(["bar"]);
  });

  it("leaves code spans and links on their existing paths", () => {
    const code = markdownToIR("`前**加粗：**后`");
    expect(code.text).toBe("前**加粗：**后");
    expect(code.styles.map((span) => span.style)).toEqual(["code"]);

    const linked = markdownToIR("[前**加粗：**后](https://example.com)");
    expect(linked.text).toBe("前加粗：后");
    expect(linked.links).toEqual([
      { start: 0, end: linked.text.length, href: "https://example.com" },
    ]);
    expect(linked.styles.filter((span) => span.style === "bold")).toEqual([
      { start: 1, end: 4, style: "bold" },
    ]);
  });
});
