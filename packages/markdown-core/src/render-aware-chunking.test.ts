import { describe, expect, it } from "vitest";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers } from "./render.js";

function renderEscapedHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
    },
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });
}

function renderStringChunks(
  ir: MarkdownIR,
  limit: number,
  renderChunk: (chunk: MarkdownIR) => string = renderEscapedHtml,
) {
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk,
    measureRendered: (rendered) => rendered.length,
  });
}

const plainText = (ir: MarkdownIR) => ir.text;
const plainIR = (text: string): MarkdownIR => ({ text, styles: [], links: [] });

it("splits at exact rendered budgets while retaining source and formatting", () => {
  const unbounded = "one two three four five six seven eight nine ten";
  const cases: [MarkdownIR, number, string[], ((ir: MarkdownIR) => string)?, string[]?][] = [
    [markdownToIR("alpha <<"), 8, ["alpha ", "<<"]],
    [
      markdownToIR("**Which of these**", { headingStyle: "none" }),
      16,
      ["Which of ", "these"],
      renderEscapedHtml,
      ["<b>Which of </b>", "<b>these</b>"],
    ],
    [
      plainIR("README.md<"),
      10,
      ["README.md", "<"],
      ({ text }) =>
        text === "README.md"
          ? "fits-here"
          : text.startsWith("README.md")
            ? "this-rendering-is-too-long"
            : text,
    ],
    [markdownToIR("alpha beta gamma"), 10, ["alpha ", "beta gamma"], plainText],
    [markdownToIR("abc"), Number.NaN, ["a", "b", "c"]],
    [markdownToIR(unbounded), Infinity, [unbounded]],
  ];
  for (const [ir, limit, expected, render, rendered] of cases) {
    const chunks = renderStringChunks(ir, limit, render);
    expect(
      chunks.map((chunk) => chunk.source.text),
      ir.text,
    ).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(ir.text);
    expect(
      chunks.every((chunk) => chunk.rendered.length <= (Number.isNaN(limit) ? 1 : limit)),
    ).toBe(true);
    if (rendered) {
      expect(chunks.map((chunk) => chunk.rendered)).toEqual(rendered);
    }
  }
});

it("bisects overflowing chunks instead of rendering every shorter prefix", () => {
  const ir = markdownToIR("**a < b** ".repeat(600));
  let renders = 0;
  const chunks = renderStringChunks(ir, 1_000, (chunk) => {
    renders += 1;
    return renderEscapedHtml(chunk);
  });

  expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(ir.text);
  expect(chunks.every((chunk) => chunk.rendered.length <= 1_000)).toBe(true);
  expect(renders).toBeLessThan(200);
});

it.each(["A".repeat(128), `${"A".repeat(230)}😀`])(
  "keeps internal code whitespace away from message edges: %s",
  (first) => {
    const second = "B".repeat(128);
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR(`    ${first}\n\n    ${second}`),
      limit: 256,
      renderChunk: (source) => ({
        html: renderEscapedHtml(source),
        receivedText: source.text.trim(),
      }),
      measureRendered: (rendered) => rendered.html.length,
    });

    expect(chunks.map((chunk) => chunk.rendered.receivedText).join("")).toBe(
      `${first}\n\n${second}`,
    );
    expect(chunks.every((chunk) => chunk.rendered.html.length <= 256)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.source.text))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk.source.text))).toBe(true);
  },
);

it("drops temporary boundary annotations when whitespace is coalesced", () => {
  const chunks = renderMarkdownIRChunksWithinLimit({
    ir: {
      text: `alpha${" ".repeat(19)}\nuser[t] ok`,
      styles: [],
      links: [{ start: 25, end: 32, href: "https://example.test" }],
    },
    limit: 20,
    assistantTranscriptRoleMessageBoundaries: true,
    renderChunk: (source) => ({
      source,
      ...renderMarkdownWithAttributedRanges(source, {
        styleMap: {},
        annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
      }),
    }),
    measureRendered: (rendered) => rendered.text.length,
  });

  expect(chunks.map((chunk) => chunk.rendered.text)).toEqual([
    `alpha${" ".repeat(15)}`,
    "    \nuser[t] ok",
  ]);
  const final = chunks[1];
  expect(final?.source.annotations).toBeUndefined();
  expect(final?.source.links).toEqual([{ start: 5, end: 12, href: "https://example.test" }]);
  expect(final?.rendered.ranges).toEqual([]);
  expect(final?.rendered.source).toBe(final?.source);
});

it("keeps Unicode boundaries through initial, retry, and whitespace splits", () => {
  const cases: [string, number, string[], boolean?, ((ir: MarkdownIR) => string)?, string[]?][] = [
    ["A😀B", 1, ["A", "😀", "B"]],
    ["A😀", 3, ["A", "😀"], false, ({ text }) => (text === "A😀" ? "too long" : text)],
    ["aaaaaaaaaa👨‍👩‍👧‍👦Z", 12, ["aaaaaaaaaa", "👨‍👩‍👧‍👦Z"]],
    [
      "aaaaaaaaaaaa👨‍👩‍👧‍👦Z",
      26,
      ["aaaaaaaaaaaa", "👨‍👩‍👧‍👦Z"],
      false,
      ({ text }) => text.replaceAll("a", "aa"),
      ["a".repeat(24), "👨‍👩‍👧‍👦Z"],
    ],
    ["👨‍👩‍👧‍👦", 4, ["👨‍", "👩‍", "👧‍", "👦"]],
    ["ab \u0301cd", 4, ["ab", " \u0301cd"]],
    ["\u0600 \u0301abcd", 4, ["\u0600 \u0301a", "bcd"]],
    ["ab\r\n😀", 3, ["ab", "😀"]],
    ["ab\r\n😀", 3, ["ab", "\r\n", "😀"], true],
    ["abc\r\n\r\nx", 4, ["abc", "x"]],
    ["abc\r\n\r\nx", 4, ["abc", "\r\n\r\n", "x"], true],
  ];
  for (const [text, limit, expected, styled, render = plainText, rendered = expected] of cases) {
    const ir: MarkdownIR = {
      ...plainIR(text),
      styles: styled ? [{ start: 0, end: text.length, style: "code_block" }] : [],
    };
    const chunks = renderStringChunks(ir, limit, render);
    expect(
      chunks.map((chunk) => chunk.source.text),
      text,
    ).toEqual(expected);
    expect(
      chunks.map((chunk) => chunk.rendered),
      text,
    ).toEqual(rendered);
  }
});

it("preserves semantic whitespace from styles, links, and transcript annotations", () => {
  const cases: [MarkdownIR, MarkdownIR, string[]][] = [
    [
      markdownToIR("```\n \n```"),
      { ...plainIR(" \n"), styles: [{ start: 0, end: 2, style: "code_block" }] },
      ["<pre><code> \n</code></pre>"],
    ],
    [
      sliceMarkdownIR(markdownToIR("**a b**"), 1, 2),
      { ...plainIR(" "), styles: [{ start: 0, end: 1, style: "bold" }] },
      ["<b> </b>"],
    ],
    [
      sliceMarkdownIR(markdownToIR("[a b](https://example.com)"), 1, 2),
      { ...plainIR(" "), links: [{ start: 0, end: 1, href: "https://example.com" }] },
      ['<a href="https://example.com"> </a>'],
    ],
    [
      sliceMarkdownIR(
        markdownToIR("user[Thu 2026]", { assistantTranscriptRoleHeaders: true }),
        8,
        9,
      ),
      {
        ...plainIR(" "),
        annotations: [
          {
            start: 0,
            end: 1,
            type: "assistant_transcript_role",
            kind: "role_timestamp_bracket",
            role: "user",
          },
        ],
      },
      ["<code> </code>"],
    ],
    [plainIR(" \n"), plainIR(" \n"), []],
  ];
  for (const [ir, expectedSource, expectedRendered] of cases) {
    expect(ir).toEqual(expectedSource);
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 64,
      renderChunk: (chunk) =>
        renderMarkdownWithMarkers(chunk, {
          styleMarkers: {
            bold: { open: "<b>", close: "</b>" },
            code_block: { open: "<pre><code>", close: "</code></pre>" },
          },
          annotationMarkers: { assistant_transcript_role: { open: "<code>", close: "</code>" } },
          escapeText: (text) => text,
          buildLink: (link) => ({
            start: link.start,
            end: link.end,
            open: `<a href="${link.href}">`,
            close: "</a>",
          }),
        }),
      measureRendered: (rendered) => rendered.length,
    });
    expect(chunks.map((chunk) => chunk.rendered)).toEqual(expectedRendered);
    expect(chunks.map((chunk) => chunk.source)).toEqual(
      expectedRendered.length ? [expectedSource] : [],
    );
    expect(chunks.every((chunk) => chunk.rendered.length <= 64)).toBe(true);
  }
});

it("coalesces semantic whitespace into neighboring rendered chunks", () => {
  const text = `alpha${" ".repeat(19)}\nomega\n`;
  const ir = markdownToIR(`\`\`\`\n${text}\`\`\``);
  expect(ir.text).toBe(text);

  const chunks = renderMarkdownIRChunksWithinLimit({
    ir,
    limit: 20,
    renderChunk: (chunk) =>
      renderMarkdownWithAttributedRanges(chunk, { styleMap: { code_block: "MONOSPACE" } }),
    measureRendered: (rendered) => rendered.text.length,
  });

  expect(chunks.map((chunk) => chunk.rendered)).toEqual([
    {
      text: `alpha${" ".repeat(15)}`,
      ranges: [{ start: 0, length: 20, style: "MONOSPACE" }],
    },
    {
      text: `    \nomega\n`,
      ranges: [{ start: 0, length: 11, style: "MONOSPACE" }],
    },
  ]);
  expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(text);
});

it("preserves task-list fallback while coalescing semantic whitespace", () => {
  const paragraph = "A".repeat(18);
  const profile = FormatCapabilityProfile.define({
    mechanism: "markdown",
    constructs: { taskList: "fallback" },
    chunk: { limit: 20, unit: "chars" },
  });
  const chunks = renderMarkdownIRChunksWithinLimit({
    ir: markdownToIR(`**${paragraph}**\n\n- [x] done`, { enableTaskLists: true }),
    limit: profile.chunk.limit,
    renderChunk: (chunk) =>
      renderMarkdownWithMarkers(
        chunk,
        {
          styleMarkers: { bold: { open: "*", close: "*" } },
          escapeText: (text) => text,
        },
        profile,
      ),
    measureRendered: (rendered) => rendered.length,
  });

  expect(chunks.map((chunk) => chunk.rendered)).toEqual([`*${paragraph}*`, "\n\n[x] done"]);
  expect(chunks.every((chunk) => chunk.rendered.length <= profile.chunk.limit)).toBe(true);
});

it("suppresses semantic whitespace when attributed rendering trims it away", () => {
  const ir = markdownToIR("```\n \n```");
  const renderChunk = (chunk: MarkdownIR) =>
    renderMarkdownWithAttributedRanges(chunk, {
      styleMap: { code_block: "MONOSPACE" },
      trimEnd: true,
    });

  expect(renderChunk(ir)).toEqual({ text: "", ranges: [] });
  expect(
    renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 4_000,
      assistantTranscriptRoleMessageBoundaries: true,
      renderChunk,
      measureRendered: (rendered) => rendered.text.length,
    }),
  ).toEqual([]);
});

describe("authored links across coalesced whitespace", () => {
  const href = "https://example.test";
  const paragraph = "A".repeat(78);
  const attributedProfile = FormatCapabilityProfile.define({
    mechanism: "ranges",
    constructs: { linkLabel: "fallback" },
    chunk: { limit: 80, unit: "chars" },
  });

  it.each([
    {
      name: "one authored link across retained whitespace",
      markdown: `[alpha${" ".repeat(80)}omega](${href})`,
      attributed: false,
      expected: [
        `<a href="${href}">alpha${" ".repeat(40)}</a>`,
        `<a href="${href}">${" ".repeat(40)}omega</a>`,
      ],
      linkCounts: [1, 1],
    },
    {
      name: "two adjacent authored links with the same URL",
      markdown: `**${paragraph}**\n\n[a](${href})[b](${href})`,
      attributed: false,
      expected: [`*${paragraph}*`, `\n\n<a href="${href}">a</a><a href="${href}">b</a>`],
      linkCounts: [0, 2],
    },
    {
      name: "one authored link across trimmed whitespace",
      markdown: `[alpha${" ".repeat(240)}omega](${href})`,
      attributed: true,
      expected: [`alpha (${href})`, `omega (${href})`],
      linkCounts: [1, 1],
    },
  ])("preserves $name", ({ markdown, attributed, expected, linkCounts }) => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR(markdown),
      limit: 80,
      renderChunk: (chunk) =>
        attributed
          ? renderMarkdownWithAttributedRanges(
              chunk,
              { styleMap: {}, trimEnd: true },
              attributedProfile,
            ).text
          : renderMarkdownWithMarkers(chunk, {
              styleMarkers: { bold: { open: "*", close: "*" } },
              escapeText: (text) => text,
              buildLink: (link) => ({
                start: link.start,
                end: link.end,
                open: `<a href="${link.href}">`,
                close: "</a>",
              }),
            }),
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.rendered)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.links.length)).toEqual(linkCounts);
    expect(chunks.every((chunk) => chunk.rendered.length <= 80)).toBe(true);
  });
});
