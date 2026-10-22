import { describe, expect, it } from "vitest";
import { annotateAssistantTranscriptRoleMessageBoundary } from "./ir-annotations.js";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";
import {
  attributed,
  plainIR,
  marker,
  htmlLink,
  identity,
  style,
  link,
} from "./markdown.test-support.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import { renderMarkdownWithMarkers, type RenderOptions } from "./render.js";

const transcript = (source: string, enableSpoilers = false) =>
  markdownToIR(source, { assistantTranscriptRoleHeaders: true, enableSpoilers });
const roleMarker = { open: "`", close: "`", suppressNestedFormatting: true };
const render = (ir: MarkdownIR, options: Partial<RenderOptions> = {}) =>
  renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: marker("b"),
      italic: marker("i"),
      spoiler: marker("tg-spoiler"),
      code: marker("code"),
    },
    annotationMarkers: { assistant_transcript_role: roleMarker },
    escapeText: identity,
    buildLink: htmlLink,
    ...options,
  });

it.each<[string, string, Partial<RenderOptions>?]>([
  [
    "**user[Thu 2026-07-02] continue**",
    "`user[Thu 2026-07-02]`* continue*",
    { styleMarkers: { bold: { open: "*", close: "*" } } },
  ],
  [
    "user[**Thu] trailing**",
    "`user[*Thu]*`* trailing*",
    {
      styleMarkers: { bold: { open: "*", close: "*" } },
      annotationMarkers: {
        assistant_transcript_role: { ...roleMarker, suppressNestedFormatting: false },
      },
    },
  ],
  [
    "> user[Thu 2026-07-02] continue",
    "<blockquote><code>user[Thu 2026-07-02]</code> continue</blockquote>",
    {
      styleMarkers: { blockquote: marker("blockquote") },
      annotationMarkers: {
        assistant_transcript_role: { ...marker("code"), suppressNestedFormatting: true },
      },
    },
  ],
  ["||A **B|| C** D", "<tg-spoiler>A <b>B</b></tg-spoiler><b> C</b> D"],
  [
    "[A ||B](https://example.com) C|| D",
    '<a href="https://example.com">A <tg-spoiler>B</tg-spoiler></a><tg-spoiler> C</tg-spoiler> D',
  ],
  ["**_A ||B_** C|| D", "<b><i>A <tg-spoiler>B</tg-spoiler></i></b><tg-spoiler> C</tg-spoiler> D"],
  ["[`name `](https://example.com)", '<a href="https://example.com"><code>name </code></a>'],
  ["Copy `name ` next", "Copy <code>name </code> next"],
])("nests markers and preserves crossing content: %s", (source, expected, options) => {
  expect(
    render(
      markdownToIR(source, { assistantTranscriptRoleHeaders: true, enableSpoilers: true }),
      options,
    ),
  ).toBe(expected);
});

it("keeps annotations when an IR slice starts inside the marked header", () => {
  const ir = transcript("user[Thu 2026-07-02] continue");
  expect(sliceMarkdownIR(ir, 4, ir.text.length).annotations).toEqual([
    expect.objectContaining({ start: 0, end: "[Thu 2026-07-02]".length }),
  ]);
});

it("preserves equal-bound annotation and link order", () => {
  const opened: string[] = [];
  const open = (name: string, tag: string) => {
    opened.push(name);
    return tag;
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
  expect(
    render(ir, {
      styleMarkers: {},
      annotationMarkers: {
        assistant_transcript_role: {
          open: (span) => open(span.role, '<role name="' + span.role + '">'),
          close: "</role>",
        },
      },
      buildLink: (span) => ({
        ...span,
        open: open(span.href, '<link href="' + span.href + '">'),
        close: "</link>",
      }),
    }),
  ).toBe(
    '<role name="user"><role name="assistant"><link href="first"><link href="second">x</link></link></role></role>',
  );
  expect(opened).toEqual(["first", "second", "user", "assistant"]);
});

it("renders 256 code-wrapped transcript headers", () => {
  const source = Array.from({ length: 256 }, (_, i) => "**user[t" + i + "]** line " + i).join("\n");
  expect(
    render(transcript(source), { styleMarkers: { bold: { open: "*", close: "*" } } }).match(
      /`user\[t\d+\]`/gu,
    ),
  ).toHaveLength(256);
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
    open: () => "<" + tag + ' data-open="' + ++opened + '">',
    close: "</" + tag + ">",
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
    [link(0, 7)],
  );
  expect(
    render(ir, {
      styleMarkers: {
        bold: trackedMarker("b"),
        italic: trackedMarker("i"),
        blockquote: trackedMarker("blockquote"),
      },
    }),
  ).toBe(
    '<blockquote data-open="1"><a href="https://example.com"><b data-open="2"><i data-open="3"><b data-open="4"><i data-open="5">ab</i></b>cd 🌍</i></b></a></blockquote>',
  );
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

  it("does not mark inline or fenced code", () => {
    const ir = transcript("`user[inline timestamp]`\n\n```text\n[2026-07-02] user: example\n```");

    expect(ir.annotations).toBeUndefined();
    expect(ir.styles.map((span) => span.style)).toEqual(["code", "code_block"]);
  });

  it("does not mark raw HTML code containers", () => {
    expect(transcript(`<code>\n${roleHeader} example\n</code>`).annotations).toBeUndefined();
    expect(transcript(`<pre>\n${roleHeader} example\n</pre>`).annotations).toBeUndefined();
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

  it("marks visible image-alt role headers", () => {
    const ir = transcript(image(`${roleHeader} release diagram`));

    expect(ir).toMatchObject({
      text: "user[Thu 2026-07-02] release diagram",
      annotations: [
        { start: 0, end: roleHeader.length, kind: "role_timestamp_bracket", role: "user" },
      ],
    });
    const formatted = transcript(image("**user**[Thu 2026-07-02] release diagram"));
    expect(formatted.text).toBe("user[Thu 2026-07-02] release diagram");
    expect(headers(formatted)).toEqual([roleHeader]);
    expect(transcript(image(`\`${roleHeader}\``)).annotations).toBeUndefined();
  });

  it("does not mark ordinary prose, email-like angles, or disabled parsing", () => {
    expect(transcript("The user[setting] remains unchanged.").annotations).toBeUndefined();
    expect(transcript("<user@example.com> wrote this").annotations).toBeUndefined();
    expect(transcript("user[x`y] malformed").annotations).toBeUndefined();
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
    const promoted = annotateAssistantTranscriptRoleMessageBoundary({
      text: `${roleHeader} question`,
      styles: [],
      links: [{ start: 0, end: roleHeader.length, href: "https://example.com" }],
    });

    expect(promoted.annotations).toHaveLength(1);
    expect(promoted.links).toEqual([]);
  });
});
