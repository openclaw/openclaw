import { expect, it } from "vitest";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import { renderMarkdownWithMarkers } from "./render.js";

const transcript = (source: string) =>
  markdownToIR(source, { assistantTranscriptRoleHeaders: true });
const styledIR = (text: string, styles: MarkdownIR["styles"]): MarkdownIR => ({
  text,
  styles,
  links: [],
});
const attributed = (text: string, ranges: [number, number, string][]) => ({
  text,
  ranges: ranges.map(([start, length, style]) => ({ start, length, style })),
});
function renderTranscript(ir: MarkdownIR, suppressNestedFormatting = true, structural = false) {
  return renderMarkdownWithMarkers(ir, {
    annotationMarkers: {
      assistant_transcript_role: {
        open: structural ? "<code>" : "`",
        close: structural ? "</code>" : "`",
        suppressNestedFormatting,
      },
    },
    styleMarkers: structural
      ? { blockquote: { open: "<blockquote>", close: "</blockquote>" } }
      : { bold: { open: "*", close: "*" } },
    escapeText: (text) => text,
  });
}

it.each<[string, string, boolean?, boolean?]>([
  ["**user[Thu 2026-07-02] continue**", "`user[Thu 2026-07-02]`* continue*"],
  ["user[**Thu] trailing**", "`user[*Thu]*`* trailing*", false],
  [
    "> user[Thu 2026-07-02] continue",
    "<blockquote><code>user[Thu 2026-07-02]</code> continue</blockquote>",
    true,
    true,
  ],
])("nests semantic annotation markers: %s", (source, expected, suppress, structural) => {
  expect(renderTranscript(transcript(source), suppress, structural)).toBe(expected);
});

it("keeps annotations when an IR slice starts inside the marked header", () => {
  const ir = transcript("user[Thu 2026-07-02] continue");
  const sliced = sliceMarkdownIR(ir, 4, ir.text.length);
  expect(sliced.annotations).toEqual([
    expect.objectContaining({ start: 0, end: "[Thu 2026-07-02]".length }),
  ]);
});

it("preserves equal-bound annotation and link order", () => {
  const opened: string[] = [];
  const rendered = renderMarkdownWithMarkers(
    {
      text: "x",
      styles: [],
      annotations: (["user", "assistant"] as const).map((role) => ({
        start: 0,
        end: 1,
        type: "assistant_transcript_role" as const,
        kind: "angle_role_header" as const,
        role,
      })),
      links: ["first", "second"].map((href) => ({ start: 0, end: 1, href })),
    },
    {
      styleMarkers: {},
      escapeText: (text) => text,
      annotationMarkers: {
        assistant_transcript_role: {
          open: (span) => {
            opened.push(span.role);
            return `<role name="${span.role}">`;
          },
          close: "</role>",
        },
      },
      buildLink: (link) => {
        opened.push(link.href);
        return {
          start: link.start,
          end: link.end,
          open: `<link href="${link.href}">`,
          close: "</link>",
        };
      },
    },
  );

  expect(rendered).toBe(
    '<role name="user"><role name="assistant"><link href="first"><link href="second">x</link></link></role></role>',
  );
  expect(opened).toEqual(["first", "second", "user", "assistant"]);
});

it("renders 256 code-wrapped transcript headers", () => {
  const markdown = Array.from(
    { length: 256 },
    (_, index) => `**user[t${index}]** line ${index}`,
  ).join("\n");
  const rendered = renderTranscript(transcript(markdown));
  expect(rendered.match(/`user\[t\d+\]`/gu)).toHaveLength(256);
});
it("merges only adjacent mapped styles without mutating the source or sharing results", () => {
  const ir = styledIR("abcdef", [
    { start: 4, end: 6, style: "bold" },
    { start: 2, end: 4, style: "code" },
    { start: 1, end: 3, style: "italic" },
    { start: 0, end: 2, style: "bold" },
    { start: 0, end: 2, style: "code_block" },
  ]);
  for (const value of [...ir.styles, ir.styles, ir.links]) {
    Object.freeze(value);
  }
  const options = {
    styleMap: { bold: "same", code: "same", code_block: "same", italic: "other" },
  };
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
  const ir = transcript("user[Thu] **[docs](https://example.com) tail**");
  expect(
    renderMarkdownWithAttributedRanges(ir, {
      styleMap: { bold: "strong" },
      annotationStyleMap: { assistant_transcript_role: "code" },
      renderLink: (link) => ` (${link.href})`,
    }),
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
    renderMarkdownWithAttributedRanges(
      styledIR("😀 CJK文字  ", [{ start: 3, end: 10, style: "bold" }]),
      { styleMap: { bold: "strong" }, trimEnd: true },
    ),
  ).toEqual(attributed("😀 CJK文字", [[3, 5, "strong"]]));
});
