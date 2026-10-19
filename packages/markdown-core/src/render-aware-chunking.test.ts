import { expect, it } from "vitest";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import {
  renderMarkdownIRChunksWithinLimit,
  type RenderedMarkdownChunk,
} from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers } from "./render.js";

const htmlLink = ({ start, end, href }: MarkdownIR["links"][number]) => ({
  start,
  end,
  open: `<a href="${href}">`,
  close: "</a>",
});
const boldMarker = { bold: { open: "*", close: "*" } };
const sourceTexts = (chunks: RenderedMarkdownChunk<unknown>[]) =>
  chunks.map(({ source }) => source.text);
const renderedValues = <T>(chunks: RenderedMarkdownChunk<T>[]) =>
  chunks.map(({ rendered }) => rendered);

function renderEscapedHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });
}

function renderChunks<T extends string | { text: string }>(
  ir: MarkdownIR,
  limit: number,
  renderChunk: (chunk: MarkdownIR) => T,
  assistantTranscriptRoleMessageBoundaries = false,
) {
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk,
    assistantTranscriptRoleMessageBoundaries,
    measureRendered: (rendered) =>
      typeof rendered === "string" ? rendered.length : rendered.text.length,
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
  for (const [ir, limit, expected, render = renderEscapedHtml, rendered] of cases) {
    const chunks = renderChunks(ir, limit, render);
    expect(sourceTexts(chunks), ir.text).toEqual(expected);
    expect(
      chunks.every((chunk) => chunk.rendered.length <= (Number.isNaN(limit) ? 1 : limit)),
    ).toBe(true);
    if (rendered) {
      expect(renderedValues(chunks)).toEqual(rendered);
    }
  }
});

it("bisects overflowing chunks instead of rendering every shorter prefix", () => {
  const ir = markdownToIR("**a < b** ".repeat(600));
  let renders = 0;
  const chunks = renderChunks(ir, 1_000, (chunk) => {
    renders += 1;
    return renderEscapedHtml(chunk);
  });

  expect(sourceTexts(chunks).join("")).toBe(ir.text);
  expect(chunks.every((chunk) => chunk.rendered.length <= 1_000)).toBe(true);
  expect(renders).toBeLessThan(200);
});

it("carries rendered code overhead across 240 lines", () => {
  const text = Array.from(
    { length: 240 },
    (_, index) => `line_${String(index).padStart(4, "0")} = compute(${index}) # padding padding`,
  ).join("\n");
  const ir = markdownToIR(`\`\`\`python\n${text}\n\`\`\``);
  const chunks = renderChunks(ir, 4_000, renderEscapedHtml);

  expect(chunks).toHaveLength(3);
  expect(sourceTexts(chunks).join("")).toBe(ir.text);
  expect(chunks.map(({ source }) => source.text.trim()).join("")).toBe(text);
  expect(chunks.every((chunk) => chunk.rendered.length <= 4_000)).toBe(true);
  expect(chunks.every((chunk) => chunk.rendered.startsWith("<pre><code>"))).toBe(true);
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
  const chunks = renderChunks(
    {
      text: `alpha${" ".repeat(19)}\nuser[t] ok`,
      styles: [],
      links: [{ start: 25, end: 32, href: "https://example.test" }],
    },
    20,
    (source) => ({
      source,
      ...renderMarkdownWithAttributedRanges(source, {
        styleMap: {},
        annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
      }),
    }),
    true,
  );

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
    const ir = plainIR(text);
    if (styled) {
      ir.styles.push({ start: 0, end: text.length, style: "code_block" });
    }
    const chunks = renderChunks(ir, limit, render);
    expect(sourceTexts(chunks), text).toEqual(expected);
    expect(renderedValues(chunks), text).toEqual(rendered);
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
    const chunks = renderChunks(ir, 64, (chunk) =>
      renderMarkdownWithMarkers(chunk, {
        styleMarkers: {
          bold: { open: "<b>", close: "</b>" },
          code_block: { open: "<pre><code>", close: "</code></pre>" },
        },
        annotationMarkers: { assistant_transcript_role: { open: "<code>", close: "</code>" } },
        escapeText: (text) => text,
        buildLink: htmlLink,
      }),
    );
    expect(renderedValues(chunks)).toEqual(expectedRendered);
    expect(chunks.map((chunk) => chunk.source)).toEqual(
      expectedRendered.length ? [expectedSource] : [],
    );
  }
});

it("coalesces semantic whitespace into neighboring rendered chunks", () => {
  const text = `alpha${" ".repeat(19)}\nomega\n`;
  const ir = markdownToIR(`\`\`\`\n${text}\`\`\``);
  expect(ir.text).toBe(text);

  const chunks = renderChunks(ir, 20, (chunk) =>
    renderMarkdownWithAttributedRanges(chunk, { styleMap: { code_block: "MONOSPACE" } }),
  );

  expect(renderedValues(chunks)).toEqual([
    {
      text: `alpha${" ".repeat(15)}`,
      ranges: [{ start: 0, length: 20, style: "MONOSPACE" }],
    },
    {
      text: `    \nomega\n`,
      ranges: [{ start: 0, length: 11, style: "MONOSPACE" }],
    },
  ]);
});

it("preserves task-list fallback while coalescing semantic whitespace", () => {
  const paragraph = "A".repeat(18);
  const profile = FormatCapabilityProfile.define({
    mechanism: "markdown",
    constructs: { taskList: "fallback" },
    chunk: { limit: 20, unit: "chars" },
  });
  const chunks = renderChunks(
    markdownToIR(`**${paragraph}**\n\n- [x] done`, { enableTaskLists: true }),
    profile.chunk.limit,
    (chunk) =>
      renderMarkdownWithMarkers(
        chunk,
        {
          styleMarkers: boldMarker,
          escapeText: (text) => text,
        },
        profile,
      ),
  );

  expect(renderedValues(chunks)).toEqual([`*${paragraph}*`, "\n\n[x] done"]);
});

it("suppresses semantic whitespace when attributed rendering trims it away", () => {
  const ir = markdownToIR("```\n \n```");
  const renderChunk = (chunk: MarkdownIR) =>
    renderMarkdownWithAttributedRanges(chunk, {
      styleMap: { code_block: "MONOSPACE" },
      trimEnd: true,
    });

  expect(renderChunk(ir)).toEqual({ text: "", ranges: [] });
  expect(renderChunks(ir, 4_000, renderChunk, true)).toEqual([]);
});

const href = "https://example.test";
const paragraph = "A".repeat(78);
const attributedProfile = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: { linkLabel: "fallback" },
  chunk: { limit: 80, unit: "chars" },
});

it.each<[string, boolean, string[], number[]]>([
  [
    `[alpha${" ".repeat(80)}omega](${href})`,
    false,
    [
      `<a href="${href}">alpha${" ".repeat(40)}</a>`,
      `<a href="${href}">${" ".repeat(40)}omega</a>`,
    ],
    [1, 1],
  ],
  [
    `**${paragraph}**\n\n[a](${href})[b](${href})`,
    false,
    [`*${paragraph}*`, `\n\n<a href="${href}">a</a><a href="${href}">b</a>`],
    [0, 2],
  ],
  [`[alpha${" ".repeat(240)}omega](${href})`, true, [`alpha (${href})`, `omega (${href})`], [1, 1]],
])(
  "preserves authored links across coalesced whitespace: %s",
  (markdown, attributed, expected, linkCounts) => {
    const chunks = renderChunks(markdownToIR(markdown), 80, (chunk) =>
      attributed
        ? renderMarkdownWithAttributedRanges(
            chunk,
            { styleMap: {}, trimEnd: true },
            attributedProfile,
          ).text
        : renderMarkdownWithMarkers(chunk, {
            styleMarkers: boldMarker,
            escapeText: (text) => text,
            buildLink: htmlLink,
          }),
    );

    expect(renderedValues(chunks)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.links.length)).toEqual(linkCounts);
  },
);
