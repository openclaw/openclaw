import { describe, expect, it } from "vitest";
import { markdownToMatrixHtml } from "./format.js";
import { buildTextContent, extractMatrixMentions } from "./send/formatting.js";

describe("extractMatrixMentions", () => {
  it("extracts user mentions from body text", () => {
    expect(extractMatrixMentions("Hello @alice:matrix.org")).toEqual(["@alice:matrix.org"]);
  });

  it("extracts multiple unique mentions", () => {
    const mentions = extractMatrixMentions("@alice:matrix.org and @bob:example.com");
    expect(mentions).toEqual(["@alice:matrix.org", "@bob:example.com"]);
  });

  it("deduplicates repeated mentions", () => {
    const mentions = extractMatrixMentions("@alice:matrix.org said hi @alice:matrix.org");
    expect(mentions).toEqual(["@alice:matrix.org"]);
  });

  it("returns empty array when no mentions", () => {
    expect(extractMatrixMentions("no mentions here")).toEqual([]);
  });
});

describe("buildTextContent m.mentions", () => {
  it("adds m.mentions for messages with user mentions", () => {
    const content = buildTextContent("Hello @alice:matrix.org");
    expect(content["m.mentions"]).toEqual({ user_ids: ["@alice:matrix.org"] });
  });

  it("omits m.mentions when no mentions present", () => {
    const content = buildTextContent("Hello world");
    expect(content["m.mentions"]).toBeUndefined();
  });
});

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
});
