// Matrix tests cover format plugin behavior.
import { describe, expect, it } from "vitest";
import { analyzeMatrixSpoilers } from "./format-spoiler-ranges.js";
import {
  MATRIX_FORMAT_PROFILE,
  markdownToMatrixBody,
  markdownToMatrixHtml,
  renderMarkdownToMatrixHtmlWithMentions,
  renderMatrixMarkdownTables,
} from "./format.js";

function createMentionClient(selfUserId = "@bot:example.org") {
  return {
    getUserId: async () => selfUserId,
  } as unknown as import("./sdk.js").MatrixClient;
}

const MATRIX_TABLE = "| Name | Age |\n|---|---|\n| Alice | 30 |";

describe("Matrix formatting migration goldens", () => {
  it.each([
    {
      name: "code inside underline content",
      markdown: "<u>`||literal||`</u>",
      body: "<u>`||literal||`</u>",
      html: "<p><u><code>||literal||</code></u></p>",
    },
  ])("preserves literal code pipes in $name text and HTML", async ({ markdown, body, html }) => {
    expect(markdownToMatrixBody(markdown)).toBe(body);
    expect(markdownToMatrixHtml(markdown)).toBe(html);
    const rendered = await renderMarkdownToMatrixHtmlWithMentions({
      markdown,
      client: createMentionClient(),
    });
    expect(rendered.html).toBe(html);
    expect(rendered.mentions).toEqual({});
  });

  it.each(["u"])("keeps code-looking pipes inside %s attributes fail closed", (tag) => {
    const markdown = `<${tag} title="\`||secret||\`">label</${tag}>`;
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

  it("does not mistake an escaped closing bracket for a link label", () => {
    const markdown = "\\](||secret||)";
    expect(markdownToMatrixHtml(markdown)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("excludes spoiler-looking pipes in valid link titles", () => {
    const markdown = '[x](https://example.test "note ) ||literal||") ||secret||';
    const html = markdownToMatrixHtml(markdown);
    expect(html).not.toContain("secret");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("scopes link metadata to blocks and preserves reference identifiers", () => {
    const stale = "[unfinished\n \n](||secret||)";
    expect(markdownToMatrixHtml(stale)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(stale)).not.toContain("secret");

    const reference = "[visible][id||x||]\n\n[id||x||]: https://example.test";
    expect(markdownToMatrixHtml(reference)).not.toContain("secret");
  });

  it("keeps spoiler formatting inside image fallback labels", () => {
    const markdown = "![||secret||](https://example.test/image.png)";
    expect(markdownToMatrixHtml(markdown)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("keeps spoiler spans nested when they cross bold formatting", () => {
    const markdown = "**||secret** more||";
    const html = markdownToMatrixHtml(markdown);
    expect(html).not.toContain("</strong> more</span>");
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
  it("does not auto-link bare file references into external urls", () => {
    const html = markdownToMatrixHtml("Check README.md and backup.sh");
    expect(html).toBe("<p>Check README.md and backup.sh</p>");
  });

  it("escapes raw HTML", () => {
    const html = markdownToMatrixHtml("<b>nope</b>");
    expect(html).toBe("<p>&lt;b&gt;nope&lt;/b&gt;</p>");
  });

  it("compacts loose lists with mentions via renderMarkdownToMatrixHtmlWithMentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "1. hello @alice:example.org\n\n2. bye",
      client: createMentionClient(),
    });
    expect(result.html).toBe(
      '<ol>\n<li>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></li>\n<li>bye</li>\n</ol>',
    );
    expect(result.mentions).toEqual({ user_ids: ["@alice:example.org"] });
  });

  it("preserves paragraph wrappers for multi-paragraph list items", () => {
    const html = markdownToMatrixHtml("1. First sentence.\n\n   Second sentence in the same item.");
    expect(html).toBe(
      "<ol>\n<li>\n<p>First sentence.</p>\n<p>Second sentence in the same item.</p>\n</li>\n</ol>",
    );
  });

  it.each([
    {
      name: "accepts bracketed homeservers in matrix mentions",
      markdown: "hello @alice:[2001:db8::1]",
      html: '<p>hello <a href="https://matrix.to/#/%40alice%3A%5B2001%3Adb8%3A%3A1%5D">@alice:[2001:db8::1]</a></p>',
      userId: "@alice:[2001:db8::1]",
    },
    {
      name: "preserves private-use characters alongside escaped and real mentions",
      markdown: "\\@room \uE000tag @alice:example.org",
      html: '<p>@room \uE000tag <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></p>',
      userId: "@alice:example.org",
    },
  ])("$name", async ({ markdown, html, userId }) => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown,
      client: createMentionClient(),
    });

    expect(result.html).toBe(html);
    expect(result.mentions).toEqual({ user_ids: [userId] });
  });

  it("treats colon-suffixed room mentions as room mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room:",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @room:</p>");
    expect(result.mentions).toEqual({
      room: true,
    });
  });

  it.each([
    {
      name: "does not emit mentions for mxid-like tokens with path suffixes",
      markdown: "hello @alice:example.org/path",
      html: "<p>hello @alice:example.org/path</p>",
    },
    {
      name: "does not emit mentions for filename-embedded mxids with trailing hyphens",
      markdown: "read matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt",
      html: "<p>read matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt</p>",
    },
    {
      name: "preserves private-use entities inside image fallback labels",
      markdown: "![&#xE000;](https://example.com/image.png)",
      html: "<p>\uE000</p>",
    },
    {
      name: "keeps escaped mentions literal after unmatched backticks",
      markdown: "`literal then \\@alice:example.org",
      html: "<p>`literal then @alice:example.org</p>",
    },
    {
      name: "restores escaped mentions in markdown link labels without linking them",
      markdown: "[\\@alice:example.org](https://example.com)",
      html: '<p><a href="https://example.com">@alice:example.org</a></p>',
    },
  ])("$name", async ({ markdown, html }) => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown,
      client: createMentionClient(),
    });

    expect(result.html).toBe(html);
    expect(result.mentions).toStrictEqual({});
  });
});
