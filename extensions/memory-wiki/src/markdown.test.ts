import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWikiPageFilename, extractWikiLinks, slugifyWikiSegment } from "./markdown.js";

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

describe("extractWikiLinks", () => {
  it("extracts obsidian-style wikilinks", () => {
    const md = "See [[sources/my-page|My Page]] for details.";
    expect(extractWikiLinks(md)).toEqual(["sources/my-page"]);
  });

  it("extracts markdown-style links", () => {
    const md = "See [My Page](sources/my-page) for details.";
    expect(extractWikiLinks(md)).toEqual(["sources/my-page"]);
  });

  it("ignores links inside fenced code blocks", () => {
    const md = [
      "Some text.",
      "",
      "```python",
      "stream = anyio.create_memory_object_stream[SessionMessage](0)",
      "other = anyio.create_memory_object_stream[SessionMessage](1)",
      "```",
      "",
      "More text.",
    ].join("\n");
    expect(extractWikiLinks(md)).toEqual([]);
  });

  it("ignores links inside longer fences", () => {
    const md = [
      "````text",
      "[label](target)",
      "````",
    ].join("\n");
    expect(extractWikiLinks(md)).toEqual([]);
  });

  it("ignores links inside HTML comments", () => {
    const md = "Text <!-- [Old Link](removed) --> more text.";
    expect(extractWikiLinks(md)).toEqual([]);
  });

  it("ignores image links", () => {
    const md = "See ![screenshot](images/shot.png) here.";
    expect(extractWikiLinks(md)).toEqual([]);
  });

  it("preserves links with inline code in link text", () => {
    const md = "See [`formatWikiLink`](sources/utils) for details.";
    expect(extractWikiLinks(md)).toEqual(["sources/utils"]);
  });

  it("still extracts links outside non-prose content", () => {
    const md = [
      "See [Real Link](sources/real-page).",
      "",
      "```python",
      "fake = obj[Foo](0)",
      "```",
      "",
      "Also [[sources/other-page|Other]].",
      "",
      "<!-- [hidden](removed) -->",
      "",
      "![img](image.png)",
    ].join("\n");
    expect(extractWikiLinks(md)).toEqual(["sources/real-page", "sources/other-page"]);
  });

  it("skips external URLs", () => {
    const md = "Visit [site](https://example.com) and [local](sources/page).";
    expect(extractWikiLinks(md)).toEqual(["sources/page"]);
  });

  it("skips anchor-only links", () => {
    const md = "Jump to [section](#heading).";
    expect(extractWikiLinks(md)).toEqual([]);
  });
});
