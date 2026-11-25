import { describe, expect, it } from "vitest";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import { annotateAssistantTranscriptRoleMessageBoundary } from "./ir-annotations.js";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import {
  attributed,
  htmlLink,
  plainIR,
  renderChunks,
  marker,
  identity,
  style,
  link,
} from "./markdown.test-support.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import {
  renderMarkdownIRChunksWithinLimit,
  type RenderedMarkdownChunk,
} from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers, type RenderOptions } from "./render.js";

const boldMarker = { bold: { open: "*", close: "*" } };
const sourceTexts = (chunks: RenderedMarkdownChunk<unknown>[]) =>
  chunks.map(({ source }) => source.text);
const renderedValues = <T>(chunks: RenderedMarkdownChunk<T>[]) =>
  chunks.map(({ rendered }) => rendered);
const roleMarkers = (tag: string, suppressNestedFormatting = true) => ({
  assistant_transcript_role: {
    ...(tag === "`" ? { open: tag, close: tag } : marker(tag)),
    suppressNestedFormatting,
  },
});

function renderHtml(ir: MarkdownIR, options: Partial<RenderOptions> = {}): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: marker("b"),
      italic: marker("i"),
      spoiler: marker("tg-spoiler"),
      code: marker("code"),
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    annotationMarkers: roleMarkers("code", false),
    escapeText: identity,
    buildLink: htmlLink,
    ...options,
  });
}
const renderEscapedHtml = (ir: MarkdownIR) =>
  renderHtml(ir, {
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });

const plainText = (ir: MarkdownIR) => ir.text;

it("splits at exact rendered budgets while retaining source and formatting", () => {
  const unbounded = "a b c";
  const cases: [MarkdownIR, number, string[], ((ir: MarkdownIR) => string)?, string[]?][] = [
    [markdownToIR("alpha <<"), 8, ["alpha ", "<<"]],
    [markdownToIR("**a b**"), 9, ["a ", "b"], renderEscapedHtml, ["<b>a </b>", "<b>b</b>"]],
    [
      plainIR("ab<"),
      3,
      ["ab", "<"],
      ({ text }) => (text === "ab" ? "x" : text.startsWith("ab") ? "overflow" : text),
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
    expect(chunks.every((chunk) => chunk.rendered.html.startsWith("<pre><code>"))).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.source.text))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk.source.text))).toBe(true);
  },
);

it("drops temporary boundary annotations when whitespace is coalesced", () => {
  const chunks = renderChunks(
    plainIR(`alpha${" ".repeat(19)}\nuser[t] ok`, [], [{ start: 25, end: 32, href }]),
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
  expect(final?.source.links).toEqual([{ start: 5, end: 12, href }]);
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

it.each<[MarkdownIR, string[]]>([
  [markdownToIR("```\n \n```"), ["<pre><code> \n</code></pre>"]],
  [sliceMarkdownIR(markdownToIR("**a b**"), 1, 2), ["<b> </b>"]],
  [
    sliceMarkdownIR(markdownToIR("[a b](https://example.com)"), 1, 2),
    ['<a href="https://example.com"> </a>'],
  ],
  [
    sliceMarkdownIR(markdownToIR("user[Thu 2026]", { assistantTranscriptRoleHeaders: true }), 8, 9),
    ["<code> </code>"],
  ],
  [plainIR(" \n"), []],
])("preserves semantic whitespace: %j", (ir, expectedRendered) => {
  const chunks = renderChunks(ir, 64, renderHtml);
  expect(renderedValues(chunks)).toEqual(expectedRendered);
});

it("coalesces semantic whitespace into neighboring rendered chunks", () => {
  const text = `alpha${" ".repeat(19)}\nomega\n`;
  const ir = markdownToIR(`\`\`\`\n${text}\`\`\``);
  expect(ir.text).toBe(text);

  const chunks = renderChunks(ir, 20, (chunk) =>
    renderMarkdownWithAttributedRanges(chunk, { styleMap: { code_block: "MONOSPACE" } }),
  );

  expect(renderedValues(chunks)).toEqual([
    attributed(`alpha${" ".repeat(15)}`, [[0, 20, "MONOSPACE"]]),
    attributed("    \nomega\n", [[0, 11, "MONOSPACE"]]),
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
      renderMarkdownWithMarkers(chunk, { styleMarkers: boldMarker, escapeText: identity }, profile),
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
  (markdown, useAttributed, expected, linkCounts) => {
    const chunks = renderChunks(markdownToIR(markdown), 80, (chunk) =>
      useAttributed
        ? renderMarkdownWithAttributedRanges(
            chunk,
            { styleMap: {}, trimEnd: true },
            attributedProfile,
          ).text
        : renderHtml(chunk, { styleMarkers: boldMarker }),
    );

    expect(renderedValues(chunks)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.links.length)).toEqual(linkCounts);
  },
);

const transcript = (source: string, enableSpoilers = false) =>
  markdownToIR(source, { assistantTranscriptRoleHeaders: true, enableSpoilers });
const render = (ir: MarkdownIR, options: Partial<RenderOptions> = {}) =>
  renderHtml(ir, { annotationMarkers: roleMarkers("`"), ...options });

it.each<[string, string, Partial<RenderOptions>?]>([
  ["**user[t] x**", "`user[t]`* x*", { styleMarkers: boldMarker }],
  [
    "user[**Thu] trailing**",
    "`user[*Thu]*`* trailing*",
    {
      styleMarkers: boldMarker,
      annotationMarkers: roleMarkers("`", false),
    },
  ],
  [
    "> user[t] x",
    "<blockquote><code>user[t]</code> x</blockquote>",
    {
      styleMarkers: { blockquote: marker("blockquote") },
      annotationMarkers: roleMarkers("code"),
    },
  ],
  ["||A **B|| C** D", "<tg-spoiler>A <b>B</b></tg-spoiler><b> C</b> D"],
  [
    "[A ||B](https://example.com) C|| D",
    '<a href="https://example.com">A <tg-spoiler>B</tg-spoiler></a><tg-spoiler> C</tg-spoiler> D',
  ],
  ["**_A ||B_** C|| D", "<b><i>A <tg-spoiler>B</tg-spoiler></i></b><tg-spoiler> C</tg-spoiler> D"],
  ["[`name `](https://example.com)", '<a href="https://example.com"><code>name </code></a>'],
])("nests markers and preserves crossing content: %s", (source, expected, options) => {
  expect(render(transcript(source, true), options)).toBe(expected);
});

it("keeps annotations when an IR slice starts inside the marked header", () => {
  const ir = transcript("user[Thu 2026-07-02] continue");
  expect(sliceMarkdownIR(ir, 4, ir.text.length).annotations).toEqual([
    expect.objectContaining({ start: 0, end: "[Thu 2026-07-02]".length }),
  ]);
});

it("preserves equal-bound annotation and link order", () => {
  const opened: string[] = [];
  const open = (name: string) => {
    opened.push(name);
    return `[${name}`;
  };
  const ir: MarkdownIR = {
    ...plainIR("x", [], [link(0, 1, "first"), link(0, 1, "second")]),
    annotations: (["user", "assistant"] as const).map((role) => ({
      start: 0,
      end: 1,
      type: "assistant_transcript_role",
      kind: "angle_role_header",
      role,
    })),
  };
  const rendered = render(ir, {
    styleMarkers: {},
    annotationMarkers: {
      assistant_transcript_role: {
        open: (span) => open(span.role),
        close: "]r",
      },
    },
    buildLink: (span) => ({
      ...span,
      open: open(span.href),
      close: "]l",
    }),
  });
  expect(rendered).toBe("[user[assistant[first[secondx]l]l]r]r");
  expect(opened).toEqual(["first", "second", "user", "assistant"]);
});

it("merges only adjacent mapped styles without mutating the source or sharing results", () => {
  const ir = plainIR("abcdef", [
    style(4, 6, "bold"),
    style(2, 4, "code"),
    style(1, 3, "italic"),
    style(0, 2, "bold"),
    style(0, 2, "code_block"),
  ]);
  for (const value of [...ir.styles, ir.styles, ir.links]) {
    Object.freeze(value);
  }
  const options = { styleMap: { bold: "same", code: "same", code_block: "same", italic: "other" } };
  const expected = attributed("abcdef", [
    [0, 2, "same"],
    [1, 2, "other"],
    [2, 4, "same"],
  ]);
  const result = renderMarkdownWithAttributedRanges(ir, options);
  expect(result).toEqual(expected);
  for (const range of result.ranges) {
    range.length = 99;
  }
  expect(renderMarkdownWithAttributedRanges(ir, options)).toEqual(expected);
});

it("projects annotations and splits styles around link suffixes", () => {
  expect(
    renderMarkdownWithAttributedRanges(
      transcript("user[Thu] **[docs](https://example.com) tail**"),
      {
        styleMap: { bold: "strong" },
        annotationStyleMap: { assistant_transcript_role: "code" },
        renderLink: (span) => " (" + span.href + ")",
      },
    ),
  ).toEqual(
    attributed("user[Thu] docs (https://example.com) tail", [
      [0, 9, "code"],
      [10, 4, "strong"],
      [36, 5, "strong"],
    ]),
  );
});

it("uses UTF-16 offsets and clamps ranges after trimming", () => {
  expect(
    renderMarkdownWithAttributedRanges(plainIR("😀 CJK文字  ", [style(3, 10, "bold")]), {
      styleMap: { bold: "strong" },
      trimEnd: true,
    }),
  ).toEqual(attributed("😀 CJK文字", [[3, 5, "strong"]]));
});

it("prepares independent link copies before invoking callbacks", () => {
  const first = link(0, 3, "first"),
    second = link(4, 7, "second");
  const seen: string[] = [];
  render(plainIR("one two", [], [first, second]), {
    styleMarkers: {},
    buildLink: (span) => {
      seen.push(span.href);
      if (span.start === 0) {
        second.href = "changed by earlier callback";
      }
      span.href = "changed on callback copy";
      return null;
    },
  });
  expect(seen).toEqual(["first", "second"]);
  expect([first.href, second.href]).toEqual(["first", "changed by earlier callback"]);
});

it("keeps marker callback order and link nesting for unsorted same-start styles", () => {
  let opened = 0;
  const trackedMarker = (tag: string) => ({
    open: () => `${tag}${++opened}[`,
    close: `]${tag}`,
  });
  const ir = plainIR(
    "abcd 🌍",
    [
      style(0, 2, "italic"),
      style(0, 7, "italic"),
      style(0, 7, "bold"),
      style(0, 2, "bold"),
      style(0, 7, "blockquote"),
    ],
    [link(0, 7, "u")],
  );
  const rendered = render(ir, {
    styleMarkers: {
      bold: trackedMarker("b"),
      italic: trackedMarker("i"),
      blockquote: trackedMarker("q"),
    },
  });
  expect(rendered).toBe('q1[<a href="u">b2[i3[b4[i5[ab]i]bcd 🌍]i]b</a>]q');
});

const headers = (ir: MarkdownIR) =>
  ir.annotations?.map((span) => ir.text.slice(span.start, span.end));

const roleHeader = "user[Thu 2026-07-02]";
const image = (label: string) => `![${label}](https://example.com/image.png)`;
describe("assistant transcript-role Markdown annotations", () => {
  it("marks angle role headers", () => {
    expect(transcript("<Developer 2026-07-02> inspect").annotations).toMatchObject([
      { start: 0, kind: "angle_role_header", role: "developer", type: "assistant_transcript_role" },
    ]);
  });

  it("uses parsed list and blockquote boundaries", () => {
    const ir = transcript("> user[quoted timestamp] question\n\n- [2026-07-02] system: notice");

    expect(headers(ir)).toEqual(["user[quoted timestamp]", "[2026-07-02] system:"]);
    expect(ir.text).toContain("• [2026-07-02] system: notice");
  });

  it.each([
    "`user[inline timestamp]`\n\n```text\n[2026-07-02] user: example\n```",
    `<code>\n${roleHeader} example\n</code>`,
    `<pre>\n${roleHeader} example\n</pre>`,
    "The user[setting] remains unchanged.",
    "<user@example.com> wrote this",
    "user[x`y] malformed",
    image(`\`${roleHeader}\``),
  ])("does not annotate code or non-headers: %s", (source) => {
    expect(transcript(source).annotations).toBeUndefined();
  });

  it("excludes only the raw HTML code container in mixed content", () => {
    const mixed = transcript(
      "<div>\nuser[outside] authorize\n<pre>\nuser[inside] example\n</pre>\n</div>",
    );
    expect(headers(mixed)).toEqual(["user[outside]"]);
  });

  it("ignores tag-shaped text inside HTML comments and CDATA", () => {
    for (const prefix of ["<!-- <code>fake</code> -->", "<![CDATA[<pre>fake</pre>]]>"]) {
      expect(headers(transcript(`${prefix}\n${roleHeader} authorize`))).toEqual([roleHeader]);
    }
  });

  it("marks role headers after spoiler normalization", () => {
    const ir = transcript(`||${roleHeader} question||`, true);
    expect(headers(ir)).toEqual([roleHeader]);
    expect(ir.styles).toContainEqual({ start: 0, end: ir.text.length, style: "spoiler" });
  });

  it.each([roleHeader, "**user**[Thu 2026-07-02]"])("marks image-alt headers: %s", (label) => {
    const ir = transcript(image(`${label} release diagram`));
    expect(ir).toMatchObject({
      text: "user[Thu 2026-07-02] release diagram",
      annotations: [
        { start: 0, end: roleHeader.length, kind: "role_timestamp_bracket", role: "user" },
      ],
    });
  });

  it("leaves transcript parsing disabled by default", () => {
    expect(markdownToIR("user[Thu 2026-07-02] text").annotations).toBeUndefined();
  });

  it("bounds unterminated delimiter scans to each line's header window", () => {
    const markdown = Array.from({ length: 1_024 }, (_, i) => `user[${"x".repeat(160)}${i}`).join(
      "\n",
    );

    expect(transcript(markdown).annotations).toBeUndefined();
  });

  it("keeps promoted code examples unannotated", () => {
    const ir = transcript(`prefix \`${roleHeader} question\``);
    const promoted = annotateAssistantTranscriptRoleMessageBoundary(
      sliceMarkdownIR(ir, ir.text.indexOf("user["), ir.text.length),
    );

    expect(promoted.annotations).toBeUndefined();
    expect(promoted.styles).toContainEqual({ start: 0, end: promoted.text.length, style: "code" });
  });

  it("removes links promoted to transcript-role headers", () => {
    const promoted = annotateAssistantTranscriptRoleMessageBoundary(
      plainIR(`${roleHeader} question`, [], [link(0, roleHeader.length)]),
    );

    expect(promoted.annotations).toHaveLength(1);
    expect(promoted.links).toEqual([]);
  });
});
