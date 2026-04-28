import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createWikiPageFilename,
  extractWikiLinks,
  inferWikiPageKind,
  renderWikiMarkdown,
  slugifyWikiSegment,
  toWikiPageSummary,
} from "./markdown.js";

describe("slugifyWikiSegment", () => {
  it("preserves Unicode letters and numbers in wiki slugs", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
    expect(slugifyWikiSegment("LLM 架构分析")).toBe("llm-架构分析");
    expect(slugifyWikiSegment("Circuit Breaker 自動恢復")).toBe("circuit-breaker-自動恢復");
  });

  it("keeps ASCII behavior unchanged", () => {
    expect(slugifyWikiSegment("hello world")).toBe("hello-world");
    expect(slugifyWikiSegment("")).toBe("page");
  });

  it("retains combining marks so distinct titles do not collapse", () => {
    expect(slugifyWikiSegment("किताब")).toBe("किताब");
    expect(slugifyWikiSegment("कुतुब")).toBe("कुतुब");
    expect(slugifyWikiSegment("कीताब")).toBe("कीताब");
  });

  it("caps long Unicode slugs to a safe filename byte length", () => {
    const title = "漢".repeat(90);
    const slug = slugifyWikiSegment(title);

    expect(slug.endsWith(`-${createHash("sha1").update(title).digest("hex").slice(0, 12)}`)).toBe(
      true,
    );
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(240);
    expect(slugifyWikiSegment(title)).toBe(slug);
  });

  it("caps composed wiki page filenames to a safe path-component length", () => {
    const stem = `bridge-${"漢".repeat(45)}-${"語".repeat(45)}`;
    const fileName = createWikiPageFilename(stem);

    expect(fileName.endsWith(".md")).toBe(true);
    expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
    expect(createWikiPageFilename(stem)).toBe(fileName);
  });
});

describe("wiki page kind inference", () => {
  it("classifies canon pages from the canon directory", () => {
    const raw = renderWikiMarkdown({
      frontmatter: {
        pageType: "canon",
        id: "canon.2026-04-25",
        title: "2026-04-25 Canon",
      },
      body: "# 2026-04-25 Canon\n\nDaily roll-up.",
    });

    expect(inferWikiPageKind("canon/2026-04-25.md")).toBe("canon");
    expect(
      toWikiPageSummary({
        absolutePath: "/tmp/wiki/canon/2026-04-25.md",
        relativePath: "canon/2026-04-25.md",
        raw,
      }),
    ).toMatchObject({
      kind: "canon",
      relativePath: "canon/2026-04-25.md",
      title: "2026-04-25 Canon",
    });
  });
});

describe("extractWikiLinks", () => {
  it("ignores wiki-like tokens inside fenced code blocks", () => {
    const markdown = [
      "# Page",
      "",
      "See [[real-page]] for context.",
      "",
      "```markdown",
      "assistant: [[reply_to_current]] — this is template syntax",
      "and should not be treated as a link.",
      "```",
    ].join("\n");
    expect(extractWikiLinks(markdown)).toEqual(["real-page"]);
  });

  it("ignores wiki-like tokens inside inline code", () => {
    const markdown = "Use the `[[reply_to_current]]` placeholder, not [[actual-page]].";
    expect(extractWikiLinks(markdown)).toEqual(["actual-page"]);
  });

  it("extracts native markdown links even when they keep the .md suffix", () => {
    const markdown = "- [Alpha](sources/alpha.md)\n- [[entities/beta|Beta]]";
    expect(extractWikiLinks(markdown).toSorted()).toEqual(
      ["entities/beta", "sources/alpha.md"].toSorted(),
    );
  });

  it("strips the managed Related block before scanning", () => {
    const markdown = [
      "# Page",
      "Visible [[inline-link]].",
      "",
      "## Related",
      "<!-- openclaw:wiki:related:start -->",
      "- [[ignored-related-link]]",
      "<!-- openclaw:wiki:related:end -->",
    ].join("\n");
    expect(extractWikiLinks(markdown)).toEqual(["inline-link"]);
  });

  it("skips protocol URLs and anchor-only links", () => {
    const markdown =
      "[Home](/home) [ext](https://example.com) [anchor](#foo) [Alpha](sources/alpha.md)";
    expect(extractWikiLinks(markdown).toSorted()).toEqual(["/home", "sources/alpha.md"].toSorted());
  });
});
