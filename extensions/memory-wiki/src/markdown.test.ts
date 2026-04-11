import { describe, expect, it } from "vitest";
import { slugifyWikiSegment } from "./markdown.js";

describe("slugifyWikiSegment", () => {
  it("keeps existing ASCII-only slug behavior stable", () => {
    expect(slugifyWikiSegment("Alpha Synthesis")).toBe("alpha-synthesis");
  });

  it("preserves CJK-only titles", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
  });

  it("preserves mixed ASCII and CJK titles while keeping ASCII normalization stable", () => {
    expect(slugifyWikiSegment("LLM 架构分析")).toBe("llm-架构分析");
  });
});
