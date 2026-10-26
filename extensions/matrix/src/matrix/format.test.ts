import { describe, expect, it } from "vitest";
import {
  markdownToMatrixBody,
  markdownToMatrixHtml,
  renderMarkdownToMatrixHtmlWithMentions,
  renderMatrixMarkdownTables,
  type MatrixMentions,
} from "./format.js";
import type { MatrixClient } from "./sdk.js";

const mentionClient = { getUserId: async () => "@bot:example.org" } as unknown as MatrixClient;
const renderMentions = (markdown: string) =>
  renderMarkdownToMatrixHtmlWithMentions({ markdown, client: mentionClient });

const MATRIX_TABLE = "| Name | Age |\n|---|---|\n| Alice | 30 |";
const literalCode = "<u>`||literal||`</u>";

describe("Matrix formatting migration goldens", () => {
  it.each([
    [literalCode, literalCode, "<p><u><code>||literal||</code></u></p>"],
    ['<u title="`||secret||`">label</u>', "[Spoiler]", "<p>[Spoiler]</p>"],
    [
      "before ||first\nsecond|| after",
      "before [Spoiler] after",
      "<p>before <span data-mx-spoiler>first<br>\nsecond</span> after</p>",
    ],
  ])("renders body and HTML consistently for %s", async (markdown, body, html) => {
    expect(markdownToMatrixBody(markdown)).toBe(body);
    expect(markdownToMatrixHtml(markdown)).toBe(html);
    expect(await renderMentions(markdown)).toEqual({ html, mentions: {} });
  });
  it("keeps explicit table fallbacks", () => {
    expect(renderMatrixMarkdownTables(MATRIX_TABLE, "block")).toBe(MATRIX_TABLE);
    expect(renderMatrixMarkdownTables(MATRIX_TABLE, "bullets")).toBe("**Alice**\n• Age: 30");
    expect(markdownToMatrixHtml(MATRIX_TABLE, { tableMode: "off" })).not.toContain("<table>");
  });

  it.each([
    ["escaped closing brackets", "\\](||secret||)"],
    ["image fallback labels", "![||secret||](https://example.test/image.png)"],
    ["unfinished links in a previous block", "[unfinished\n \n](||secret||)"],
    ["unresolved references", "[x][missing||secret||]"],
    ["invalid definitions", "[id]: <broken destination> ||secret||"],
  ])("keeps spoilers in %s", (_label, markdown) => {
    expect(markdownToMatrixHtml(markdown)).toContain("<span data-mx-spoiler>secret</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it.each([
    '[x](https://example.test "note ) ||literal||") ||secret||',
    "<ftp://example.test/a||literal||> ||secret||",
  ])("excludes link metadata from spoilers in %s", (markdown) => {
    expect(markdownToMatrixHtml(markdown)).not.toContain("secret");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("preserves reference identifiers", () => {
    const reference = "[visible][id||x||]\n\n[id||x||]: https://example.test";
    expect(markdownToMatrixHtml(reference)).toContain('<a href="https://example.test">visible</a>');
  });

  it("keeps spoiler spans nested when they cross bold formatting", () => {
    const markdown = "**||secret** more||";
    expect(markdownToMatrixHtml(markdown)).not.toContain("</strong> more</span>");
    expect(markdownToMatrixBody(markdown)).not.toContain("secret");
  });

  it("leaves compact empty-cell pipes to native table grammar", () => {
    const markdown = "| A | B | C |\n|---|---|---|\n| x || y || z |";
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

  it.each([
    [
      "1. hello @alice:example.org\n\n2. bye",
      '<ol>\n<li>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></li>\n<li>bye</li>\n</ol>',
      { user_ids: ["@alice:example.org"] },
    ],
    [
      "hello @alice:[2001:db8::1]",
      '<p>hello <a href="https://matrix.to/#/%40alice%3A%5B2001%3Adb8%3A%3A1%5D">@alice:[2001:db8::1]</a></p>',
      { user_ids: ["@alice:[2001:db8::1]"] },
    ],
    [
      "\\@room \uE000tag @alice:example.org",
      '<p>@room \uE000tag <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></p>',
      { user_ids: ["@alice:example.org"] },
    ],
    ["hello @room:", "<p>hello @room:</p>", { room: true }],
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
  ] satisfies [string, string, MatrixMentions?][])(
    "renders mentions in %s",
    async (markdown, html, mentions = {}) => {
      expect(await renderMentions(markdown)).toStrictEqual({ html, mentions });
    },
  );
});
