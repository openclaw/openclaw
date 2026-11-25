import { describe, expect, it } from "vitest";
import { analyzeMatrixSpoilers } from "./format-spoiler-ranges.js";
import {
  MATRIX_FORMAT_PROFILE,
  markdownToMatrixBody,
  markdownToMatrixHtml,
  renderMarkdownToMatrixHtmlWithMentions,
  renderMatrixMarkdownTables,
} from "./format.js";
import type { MatrixClient } from "./sdk.js";

const mentionClient = { getUserId: async () => "@bot:example.org" } as unknown as MatrixClient;
const renderMentions = (markdown: string) =>
  renderMarkdownToMatrixHtmlWithMentions({ markdown, client: mentionClient });

const MATRIX_TABLE = "| Name | Age |\n|---|---|\n| Alice | 30 |";

describe("Matrix formatting migration goldens", () => {
  it("preserves literal code pipes inside underline text and HTML", async () => {
    const markdown = "<u>`||literal||`</u>";
    const html = "<p><u><code>||literal||</code></u></p>";
    expect(markdownToMatrixBody(markdown)).toBe(markdown);
    expect(markdownToMatrixHtml(markdown)).toBe(html);
    expect(await renderMentions(markdown)).toEqual({ html, mentions: {} });
  });

  it("keeps code-looking pipes inside underline attributes fail closed", () => {
    const markdown = '<u title="`||secret||`">label</u>';
    expect(markdownToMatrixBody(markdown)).toBe("[Spoiler]");
    expect(markdownToMatrixHtml(markdown)).toBe("<p>[Spoiler]</p>");
  });
  it("declares the Matrix HTML profile and keeps explicit table fallbacks", () => {
    expect(MATRIX_FORMAT_PROFILE).toMatchObject({
      mechanism: "html",
      constructs: { spoiler: "native", underline: "native", table: "native" },
      chunk: { limit: 4_000, unit: "chars" },
    });
    expect(renderMatrixMarkdownTables(MATRIX_TABLE, "block")).toBe(MATRIX_TABLE);
    expect(renderMatrixMarkdownTables(MATRIX_TABLE, "bullets")).toBe("**Alice**\n• Age: 30");
    expect(markdownToMatrixHtml(MATRIX_TABLE, { tableMode: "off" })).not.toContain("<table>");
  });

  it("pairs spoilers across a soft line break within one paragraph", () => {
    const markdown = "before ||first\nsecond|| after";
    expect(markdownToMatrixHtml(markdown)).toContain(
      "<span data-mx-spoiler>first<br>\nsecond</span>",
    );
    expect(markdownToMatrixBody(markdown)).toBe("before [Spoiler] after");
  });

  it.each([
    ["escaped closing brackets", "\\](||secret||)"],
    ["image fallback labels", "![||secret||](https://example.test/image.png)"],
  ])("keeps spoilers in %s", (_label, markdown) => {
    expect(markdownToMatrixHtml(markdown)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("excludes spoiler-looking pipes in valid link titles", () => {
    const markdown = '[x](https://example.test "note ) ||literal||") ||secret||';
    expect(markdownToMatrixHtml(markdown)).not.toContain("secret");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("scopes link metadata to blocks and preserves reference identifiers", () => {
    const stale = "[unfinished\n \n](||secret||)";
    expect(markdownToMatrixHtml(stale)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(stale)).not.toContain("secret");

    const reference = "[visible][id||x||]\n\n[id||x||]: https://example.test";
    expect(markdownToMatrixHtml(reference)).not.toContain("secret");
  });

  it("keeps spoiler spans nested when they cross bold formatting", () => {
    const markdown = "**||secret** more||";
    expect(markdownToMatrixHtml(markdown)).not.toContain("</strong> more</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("follows parsed autolink and resolved-reference metadata", () => {
    const autolink = "<ftp://example.test/a||literal||> ||secret||";
    expect(markdownToMatrixHtml(autolink)).not.toContain("secret");

    const unresolved = "[x][missing||secret||]";
    expect(markdownToMatrixHtml(unresolved)).toContain("<span data-mx-spoiler>secret</span>");

    const invalidDefinition = "[id]: <broken destination> ||secret||";
    expect(markdownToMatrixHtml(invalidDefinition)).toContain(
      "<span data-mx-spoiler>secret</span>",
    );
  });

  it("leaves compact empty-cell pipes to native table grammar", () => {
    const markdown = "| A | B | C |\n|---|---|---|\n| x || y || z |";
    expect(analyzeMatrixSpoilers(markdown).delimiterOffsets).toEqual([]);
    expect(markdownToMatrixHtml(markdown)).toContain("<table>");
    expect(markdownToMatrixBody(markdown)).toBe(markdown);
  });

  it("fails closed when every private marker is already present", () => {
    const privateUse = Array.from({ length: 0x1900 }, (_, index) =>
      String.fromCharCode(0xe000 + index),
    ).join("");
    expect(() => markdownToMatrixHtml(`${privateUse} ||secret||`)).toThrow(
      "exhausted its private marker pool",
    );
  });
});

describe("markdownToMatrixHtml", () => {
  it.each([
    ["file references", "Check README.md and backup.sh", "<p>Check README.md and backup.sh</p>"],
    ["raw HTML", "<b>nope</b>", "<p>&lt;b&gt;nope&lt;/b&gt;</p>"],
    [
      "multi-paragraph list items",
      "1. First sentence.\n\n   Second sentence in the same item.",
      "<ol>\n<li>\n<p>First sentence.</p>\n<p>Second sentence in the same item.</p>\n</li>\n</ol>",
    ],
  ])("preserves %s", (_label, markdown, html) => {
    expect(markdownToMatrixHtml(markdown)).toBe(html);
  });

  it("compacts loose lists with mentions via renderMarkdownToMatrixHtmlWithMentions", async () => {
    expect(await renderMentions("1. hello @alice:example.org\n\n2. bye")).toEqual({
      html: '<ol>\n<li>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></li>\n<li>bye</li>\n</ol>',
      mentions: { user_ids: ["@alice:example.org"] },
    });
  });

  it.each([
    [
      "hello @alice:[2001:db8::1]",
      '<p>hello <a href="https://matrix.to/#/%40alice%3A%5B2001%3Adb8%3A%3A1%5D">@alice:[2001:db8::1]</a></p>',
      "@alice:[2001:db8::1]",
    ],
    [
      "\\@room \uE000tag @alice:example.org",
      '<p>@room \uE000tag <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></p>',
      "@alice:example.org",
    ],
  ])("renders mentions in %s", async (markdown, html, userId) => {
    expect(await renderMentions(markdown)).toEqual({ html, mentions: { user_ids: [userId] } });
  });

  it("treats colon-suffixed room mentions as room mentions", async () => {
    expect(await renderMentions("hello @room:")).toEqual({
      html: "<p>hello @room:</p>",
      mentions: { room: true },
    });
  });

  it.each([
    ["hello @alice:example.org/path", "<p>hello @alice:example.org/path</p>"],
    [
      "read matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt",
      "<p>read matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt</p>",
    ],
    ["![&#xE000;](https://example.com/image.png)", "<p>\uE000</p>"],
    ["`literal then \\@alice:example.org", "<p>`literal then @alice:example.org</p>"],
    [
      "[\\@alice:example.org](https://example.com)",
      '<p><a href="https://example.com">@alice:example.org</a></p>',
    ],
  ])("preserves literal text without mentions in %s", async (markdown, html) => {
    expect(await renderMentions(markdown)).toStrictEqual({ html, mentions: {} });
  });
});
