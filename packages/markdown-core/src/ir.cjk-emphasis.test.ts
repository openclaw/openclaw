import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

describe("markdownToIR CJK emphasis", () => {
  it("parses bold labels ending with CJK punctuation without requiring a space", () => {
    const ir = markdownToIR("边界：**社区显示：**Fable 与 **有效**。");

    expect(ir.text).toBe("边界：社区显示：Fable 与 有效。");
    expect(
      ir.styles
        .filter((span) => span.style === "bold")
        .map((span) => ir.text.slice(span.start, span.end)),
    ).toEqual(["社区显示：", "有效"]);
  });

  it("keeps non-CJK label punctuation under CommonMark flanking rules", () => {
    const ir = markdownToIR("Label: **Status:**ready and **ok**.");

    expect(ir.text).toBe("Label: **Status:**ready and ok.");
    expect(
      ir.styles
        .filter((span) => span.style === "bold")
        .map((span) => ir.text.slice(span.start, span.end)),
    ).toEqual(["ok"]);
  });
});
