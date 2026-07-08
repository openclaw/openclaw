// Regression coverage for #102162: bare URLs on the Telegram HTML text path
// (textMode: "html") must be wrapped in explicit anchors so the query-string
// `&` lives in the href — which Telegram decodes when navigating — instead of a
// literal `&amp;` in auto-linked visible text that breaks multi-parameter URLs.
import { describe, expect, it } from "vitest";
import {
  linkifyBareTelegramHtmlUrls,
  markdownToTelegramHtml,
  normalizeTelegramOutboundRichHtml,
  renderTelegramHtmlText,
} from "./format.js";

const MULTI_PARAM_URL = "https://example.com/wp-admin/post.php?post=100&action=edit";
const MULTI_PARAM_HREF = "https://example.com/wp-admin/post.php?post=100&amp;action=edit";
const ANCHORED = `<a href="${MULTI_PARAM_HREF}">${MULTI_PARAM_HREF}</a>`;

describe("bare URL linkification on the Telegram HTML text path (#102162)", () => {
  it("wraps a bare multi-parameter URL so & rides in the href, not visible text", () => {
    expect(renderTelegramHtmlText(MULTI_PARAM_URL, { textMode: "html" })).toBe(ANCHORED);
  });

  it("wraps bare URLs embedded in surrounding text", () => {
    expect(renderTelegramHtmlText(`See ${MULTI_PARAM_URL} now`, { textMode: "html" })).toBe(
      `See ${ANCHORED} now`,
    );
  });

  it("also wraps on the rich outbound normalization path", () => {
    expect(normalizeTelegramOutboundRichHtml(MULTI_PARAM_URL).html).toBe(ANCHORED);
    // Idempotent when the caller already HTML-escaped the ampersand.
    expect(normalizeTelegramOutboundRichHtml(MULTI_PARAM_HREF).html).toBe(ANCHORED);
  });

  it("leaves the markdown path (which already linkifies) unchanged", () => {
    expect(markdownToTelegramHtml(MULTI_PARAM_URL)).toBe(ANCHORED);
  });

  it("does not double-wrap a URL that is already an anchor", () => {
    const html = `<a href="${MULTI_PARAM_HREF}">click</a>`;
    expect(linkifyBareTelegramHtmlUrls(html)).toBe(html);
  });

  it("does not linkify URLs inside <code> or <pre>", () => {
    const code = `<code>${MULTI_PARAM_HREF}</code>`;
    expect(linkifyBareTelegramHtmlUrls(code)).toBe(code);
    const pre = `<pre>${MULTI_PARAM_HREF}</pre>`;
    expect(linkifyBareTelegramHtmlUrls(pre)).toBe(pre);
  });

  it("does not linkify a URL inside an escaped (unsupported) tag's attribute", () => {
    const escapedImg = '&lt;img src="https://example.com/diagram.png"&gt;';
    expect(linkifyBareTelegramHtmlUrls(escapedImg)).toBe(escapedImg);
  });

  it("keeps trailing sentence punctuation outside the link", () => {
    const url = "https://example.com/a?x=1&y=2";
    const href = "https://example.com/a?x=1&amp;y=2";
    expect(renderTelegramHtmlText(`Go to ${url}.`, { textMode: "html" })).toBe(
      `Go to <a href="${href}">${href}</a>.`,
    );
  });

  it("stops the link at an escaped angle bracket following the URL", () => {
    // `https://x.example` then an escaped `<br>` that is not part of the URL.
    const input = "https://x.example&lt;br&gt;";
    expect(linkifyBareTelegramHtmlUrls(input)).toBe(
      '<a href="https://x.example">https://x.example</a>&lt;br&gt;',
    );
  });
});
