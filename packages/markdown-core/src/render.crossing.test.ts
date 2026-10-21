import { describe, expect, it } from "vitest";
import { markdownToIR, type MarkdownIR } from "./ir.js";
import { renderMarkdownWithMarkers, type RenderOptions } from "./render.js";

const renderOptions: RenderOptions = {
  styleMarkers: {
    bold: { open: "<b>", close: "</b>" },
    italic: { open: "<i>", close: "</i>" },
    spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
  },
  escapeText: (text) => text,
  buildLink: (link) => ({
    start: link.start,
    end: link.end,
    open: `<a href="${link.href}">`,
    close: "</a>",
  }),
};
function render(ir: MarkdownIR, styleMarkers = renderOptions.styleMarkers) {
  return renderMarkdownWithMarkers(ir, { ...renderOptions, styleMarkers });
}

describe("renderMarkdownWithMarkers crossing spans", () => {
  it("prepares independent link copies before invoking callbacks", () => {
    const first = { start: 0, end: 3, href: "first" };
    const second = { start: 4, end: 7, href: "second" };
    const seen: string[] = [];

    renderMarkdownWithMarkers(
      { text: "one two", styles: [], links: [first, second] },
      {
        styleMarkers: {},
        escapeText: (text) => text,
        buildLink: (link) => {
          seen.push(link.href);
          if (link.start === 0) {
            second.href = "changed by earlier callback";
          }
          link.href = "changed on callback copy";
          return null;
        },
      },
    );

    expect(seen).toEqual(["first", "second"]);
    expect([first.href, second.href]).toEqual(["first", "changed by earlier callback"]);
  });

  it.each([
    ["||A **B|| C** D", "<tg-spoiler>A <b>B</b></tg-spoiler><b> C</b> D"],
    [
      "[A ||B](https://example.com) C|| D",
      '<a href="https://example.com">A <tg-spoiler>B</tg-spoiler></a><tg-spoiler> C</tg-spoiler> D',
    ],
    [
      "**_A ||B_** C|| D",
      "<b><i>A <tg-spoiler>B</tg-spoiler></i></b><tg-spoiler> C</tg-spoiler> D",
    ],
  ])("preserves crossing text and formatting: %s", (markdown, html) => {
    const ir = markdownToIR(markdown, { enableSpoilers: true });
    expect(render(ir)).toBe(html);
  });

  it("keeps marker callback order and link nesting for unsorted same-start styles", () => {
    let opened = 0;
    const marker = (tag: string) => ({
      open: () => `<${tag} data-open="${++opened}">`,
      close: `</${tag}>`,
    });

    expect(
      render(
        {
          text: "abcd 🌍",
          styles: [
            { start: 0, end: 2, style: "italic" },
            { start: 0, end: 7, style: "italic" },
            { start: 0, end: 7, style: "bold" },
            { start: 0, end: 2, style: "bold" },
            { start: 0, end: 7, style: "blockquote" },
          ],
          links: [{ start: 0, end: 7, href: "https://example.com" }],
        },
        { bold: marker("b"), italic: marker("i"), blockquote: marker("blockquote") },
      ),
    ).toBe(
      '<blockquote data-open="1"><a href="https://example.com"><b data-open="2"><i data-open="3"><b data-open="4"><i data-open="5">ab</i></b>cd 🌍</i></b></a></blockquote>',
    );
  });
});

describe("renderMarkdownWithMarkers code content", () => {
  it.each([
    ["[`name `](https://example.com)", '<a href="https://example.com"><code>name </code></a>'],
    ["Copy `name ` next", "Copy <code>name </code> next"],
  ])("renders authored code whitespace: %s", (markdown, html) => {
    expect(render(markdownToIR(markdown), { code: { open: "<code>", close: "</code>" } })).toBe(
      html,
    );
  });
});
