import { describe, expect, it } from "vitest";
import { slugifyWikiSegment } from "./markdown.js";

describe("slugifyWikiSegment (#64620)", () => {
  it("slugifies ASCII text normally", () => {
    expect(slugifyWikiSegment("Hello World")).toBe("hello-world");
    expect(slugifyWikiSegment("my-page-title")).toBe("my-page-title");
    expect(slugifyWikiSegment("  spaced  out  ")).toBe("spaced-out");
  });

  it("preserves CJK characters in slugs", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
    expect(slugifyWikiSegment("断路器自动恢复")).toBe("断路器自动恢复");
  });

  it("produces distinct slugs for different CJK titles", () => {
    const slug1 = slugifyWikiSegment("大语言模型概述");
    const slug2 = slugifyWikiSegment("断路器自动恢复");
    expect(slug1).not.toBe(slug2);
    expect(slug1).not.toBe("page");
    expect(slug2).not.toBe("page");
  });

  it("handles mixed ASCII and CJK text", () => {
    expect(slugifyWikiSegment("LLM 大语言模型 overview")).toBe("llm-大语言模型-overview");
  });

  it("preserves Cyrillic and other non-Latin scripts", () => {
    expect(slugifyWikiSegment("Привет мир")).toBe("привет-мир");
  });

  it("falls back to 'page' only when input is empty or all-punctuation", () => {
    expect(slugifyWikiSegment("")).toBe("page");
    expect(slugifyWikiSegment("!@#$%")).toBe("page");
    expect(slugifyWikiSegment("   ")).toBe("page");
  });
});
