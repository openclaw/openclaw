import { describe, expect, it } from "vitest";
import { markdownToMatrixHtml, renderMarkdownToMatrixHtmlWithMentions } from "./format.js";

function createMentionClient(joinedMembers: string[] = [], selfUserId = "@bot:example.org") {
  return {
    getJoinedRoomMembers: async () => joinedMembers,
    getUserId: async () => selfUserId,
  } as unknown as import("./sdk.js").MatrixClient;
}

describe("markdownToMatrixHtml", () => {
  it("renders basic inline formatting", () => {
    const html = markdownToMatrixHtml("hi _there_ **boss** `code`");
    expect(html).toContain("<em>there</em>");
    expect(html).toContain("<strong>boss</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders links as HTML", () => {
    const html = markdownToMatrixHtml("see [docs](https://example.com)");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  it("does not auto-link bare file references into external urls", () => {
    const html = markdownToMatrixHtml("Check README.md and backup.sh");
    expect(html).toContain("README.md");
    expect(html).toContain("backup.sh");
    expect(html).not.toContain('href="http://README.md"');
    expect(html).not.toContain('href="http://backup.sh"');
  });

  it("keeps real domains linked even when path segments look like filenames", () => {
    const html = markdownToMatrixHtml("See https://docs.example.com/backup.sh");
    expect(html).toContain('href="https://docs.example.com/backup.sh"');
  });

  it("escapes raw HTML", () => {
    const html = markdownToMatrixHtml("<b>nope</b>");
    expect(html).toContain("&lt;b&gt;nope&lt;/b&gt;");
    expect(html).not.toContain("<b>nope</b>");
  });

  it("flattens images into alt text", () => {
    const html = markdownToMatrixHtml("![alt](https://example.com/img.png)");
    expect(html).toContain("alt");
    expect(html).not.toContain("<img");
  });

  it("preserves line breaks", () => {
    const html = markdownToMatrixHtml("line1\nline2");
    expect(html).toContain("<br");
  });

  it("renders qualified Matrix user mentions as matrix.to links and m.mentions metadata", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:example.org",
      client: createMentionClient(),
      roomId: "!room:example.org",
    });

    expect(result.html).toContain('href="https://matrix.to/#/@alice:example.org"');
    expect(result.mentions).toEqual({
      user_ids: ["@alice:example.org"],
    });
  });

  it("resolves unique bare localpart mentions from joined room members", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice",
      client: createMentionClient(["@alice:example.org", "@bob:example.org"]),
      roomId: "!room:example.org",
    });

    expect(result.html).toContain('href="https://matrix.to/#/@alice:example.org"');
    expect(result.mentions).toEqual({
      user_ids: ["@alice:example.org"],
    });
  });

  it("leaves ambiguous bare localpart mentions as plain text", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice",
      client: createMentionClient(["@alice:example.org", "@alice:elsewhere.org"]),
      roomId: "!room:example.org",
    });

    expect(result.html).not.toContain('href="https://matrix.to/#/@alice:example.org"');
    expect(result.mentions).toEqual({});
  });

  it("does not convert mentions inside code spans", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "`@alice:example.org`",
      client: createMentionClient(),
      roomId: "!room:example.org",
    });

    expect(result.html).toContain("<code>@alice:example.org</code>");
    expect(result.html).not.toContain("matrix.to");
    expect(result.mentions).toEqual({});
  });
});
