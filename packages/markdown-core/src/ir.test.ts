import { expect, it } from "vitest";
import { chunkText } from "./chunk-text.js";
import type { MarkdownIRWithMetadata as IRWithMetadata } from "./ir-metadata.js";
import { applyMarkdownTextEdits, isAutoLinkedMarkdownLink } from "./ir-spans.js";
import {
  appendMarkdownIR,
  chunkMarkdownIR,
  countMarkdownFencedCodeChars,
  markdownToIR as parseMarkdownToIR,
  markdownToIRWithMeta,
  sliceMarkdownIR as sliceParsedMarkdownIR,
  type MarkdownIR,
} from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers } from "./render.js";

const markdownToIR: (...args: Parameters<typeof parseMarkdownToIR>) => IRWithMetadata =
  parseMarkdownToIR;
const sliceMarkdownIR: (...args: Parameters<typeof sliceParsedMarkdownIR>) => IRWithMetadata =
  sliceParsedMarkdownIR;

const href = "https://example.com";
const makeStyle = (start: number, end: number, style: MarkdownIR["styles"][number]["style"]) => ({
  start,
  end,
  style,
});
const makeLink = (start: number, end: number, url = href) => ({ start, end, href: url });
const plainIR = (
  text: string,
  styles: MarkdownIR["styles"] = [],
  links: MarkdownIR["links"] = [],
): MarkdownIR => ({ text, styles, links });
const htmlTag = (start: number, end: number, raw: string, name: string, closing = false) => ({
  start,
  end,
  raw,
  name,
  closing,
  selfClosing: false,
});

function expectWellFormedUtf16(text: string): void {
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
}

it("keeps document references and changed options local to each parse", () => {
  const options = { linkify: false };
  const hrefs = (source: string) => markdownToIR(source, options).links.map((span) => span.href);
  expect(hrefs("[ref]: https://example.org/doc\n\n[ref]")).toEqual(["https://example.org/doc"]);
  expect(hrefs("[ref] example.org")).toEqual([]);
  options.linkify = true;
  expect(hrefs("[ref] example.org")).toEqual(["http://example.org"]);
  options.linkify = false;
  expect(hrefs("[ref] example.org")).toEqual([]);
});

it("expands a slice starting inside the first of consecutive surrogate pairs", () => {
  expect(sliceMarkdownIR(markdownToIR("😀🐱"), 1, 4).text).toBe("😀🐱");
});

it("preserves native fractional and non-finite slice index semantics", () => {
  const ir = markdownToIR("[**abcd**](https://example.com)");
  for (const [start, end] of [
    [-1.5, 4],
    [0, -1.5],
    [1.5, 3.9],
    [Number.NaN, 2],
    [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
  ] as const) {
    const sliced = sliceMarkdownIR(ir, start, end);
    const expected = ir.text.slice(start, end);
    const length = expected.length;
    expect(sliced).toMatchObject(
      plainIR(expected, [makeStyle(0, length, "bold")], [makeLink(0, length)]),
    );
  }
});

it("aligns linked styles when a negative slice start bisects a surrogate pair", () => {
  const ir = markdownToIR("a[**😀b**](https://example.com)");
  const sliced = sliceMarkdownIR(ir, -2, ir.text.length);
  expectWellFormedUtf16(sliced.text);
  expect(sliced).toMatchObject(plainIR("😀b", [makeStyle(0, 3, "bold")], [makeLink(0, 3)]));
});

it("keeps transcript annotations and links aligned with the expanded end", () => {
  const ir = markdownToIR("user[Thu 2026-07-02] **A😀B** [C🐱D](https://example.com)", {
    assistantTranscriptRoleHeaders: true,
  });
  const catStart = ir.text.indexOf("🐱");
  const sliced = sliceMarkdownIR(ir, 0, catStart + 1);
  expect(catStart).toBeGreaterThan(0);
  expectWellFormedUtf16(sliced.text);
  expect(sliced).toMatchObject({
    text: ir.text.slice(0, catStart + 2),
    annotations: ir.annotations,
    styles: ir.styles,
    links: [{ start: ir.links[0]?.start, end: sliced.text.length, href }],
  });
});

it("projects styled row labels and linked code cells into labeled bullets", () => {
  const ir = markdownToIR(
    "| Name | Value | Other |\n| --- | --- | --- |\n| _Row_ | [` a`](https://example.com) | ` ` |\n| Plain | Data | Last |",
    { tableMode: "bullets" },
  );
  expect(ir.text).toBe("Row\n• Value:  a\n• Other:  \n\nPlain\n• Value: Data\n• Other: Last");
  expect(ir.styles.map(({ start, end, style }) => [style, ir.text.slice(start, end)])).toEqual([
    ["bold", "Row"],
    ["italic", "Row"],
    ["code", " a"],
    ["code", " "],
    ["bold", "Plain"],
  ]);
  expect(ir.links).toEqual([{ start: 13, end: 15, href }]);
});

it("aligns code tables by visible cell content, discarding inner styles and links", () => {
  const ir = markdownToIR(
    "| | A | BB | Long |\n| --- | --- | --- | --- |\n| **类型** | *👨‍👩‍👧‍👦* | [` abc`](https://example.com) | ~~abc~~ |\n| © | 1️ | `abc ` | A |\n| | 1 | 22 | data |",
    { tableMode: "code" },
  );
  const text = [
    "|      | A   | BB   | Long |",
    "| ---- | --- | ---- | ---- |",
    "| 类型 | 👨‍👩‍👧‍👦  |  abc | abc  |",
    "| ©    | 1️   | abc  | A    |",
    "|      | 1   | 22   | data |",
    "",
  ].join("\n");
  expect(ir).toEqual(plainIR(text, [makeStyle(0, text.length, "code_block")]));
});

it.each<[string, string, MarkdownIR["styles"]]>([
  [
    "<u>under <ins>nested</ins></u> and __bold__",
    "under nested and bold",
    [makeStyle(0, 12, "underline"), makeStyle(17, 21, "bold")],
  ],
  [
    '<div title="<u>">\n**bold**\n<!-- <u> -->\n</div>',
    '<div title="<u>">\nbold\n<!-- <u> -->\n</div>',
    [makeStyle(18, 22, "bold")],
  ],
])("limits HTML underline parsing: %s", (markdown, text, styles) => {
  const ir = markdownToIR(markdown, { enableHtmlUnderline: true });
  expect(ir).toMatchObject({ text, styles });
});

it("records whether a fenced block owns an explicit closing fence", () => {
  const unclosed = { codeOrigin: "fenced", codeClosed: false };
  for (const [source, expected, firstBlock] of [
    ...["```ts\nunclosed", "```\n    ```", "```\n\t```", "```\n> ```"].map(
      (candidate) => [candidate, unclosed, true] as const,
    ),
    ["```ts", { ...unclosed, start: 0, end: 1 }, true],
    ["- ```\n  code\n  ```", { codeClosed: true, depth: 2 }],
    ["> ```\n> code\n> ```", { codeClosed: true, depth: 2 }],
    ["10. >   ```\n    >   code\n    >   ```", { codeClosed: true, depth: 3 }],
    ["> - > 10. ```\n>   >     code\n>   >     ```", { codeClosed: true, depth: 5 }],
    ["- item\n   ```\n   code\n  ```", { codeClosed: true }],
    [">\t```\n>\tcode\n>\t```", { codeClosed: true, blockquoteDepth: 1 }],
    ["   - ```\n     code", { codeClosed: false }],
  ] as const) {
    const blocks = markdownToIR(source).blocks;
    expect(
      firstBlock ? blocks?.[0] : blocks?.find((block) => block.kind === "code_block"),
    ).toMatchObject(expected);
  }
});

it("records setext headings and thematic breaks without changing rendered bytes", () => {
  const ir = markdownToIR("setext\n---\n\n***", { horizontalRuleText: "" });

  expect(ir.blocks).toMatchObject([
    { kind: "heading", headingOrigin: "setext", headingLevel: 2 },
    { kind: "thematic_break", start: ir.text.length, end: ir.text.length },
  ]);
});

it("retains zero-length blockquote ownership", () => {
  const ir = markdownToIR("> ***", { horizontalRuleText: "" });

  expect(ir.blocks?.find((block) => block.kind === "blockquote")).toMatchObject({
    start: 0,
    end: 0,
    blockquoteDepth: 1,
  });
  const surrounded = markdownToIR("before\n\n>\n\nafter");
  const quote = surrounded.blocks?.find((block) => block.kind === "blockquote");
  expect(quote?.end).toBeGreaterThanOrEqual(quote?.start ?? 0);
  const zeroHeading = markdownToIR("#####", { headingStyle: "rich" });
  expect(sliceMarkdownIR(zeroHeading, 0, zeroHeading.text.length).blocks?.[0]).toMatchObject({
    kind: "heading",
    start: 0,
    end: 0,
  });
  const withText = markdownToIR("text\n#####", { headingStyle: "rich" });
  expect(sliceMarkdownIR(withText, 0, withText.text.length).blocks).toBeUndefined();
});

it("retains CommonMark content indentation after wide marker padding", () => {
  const source = "-     code";
  const item = markdownToIR(source).listItems?.[0];

  expect(source.slice(item?.sourceContent?.start, item?.sourceContent?.end)).toBe("    code");
  expect(item?.sourceIndent).toBe(2);
  expect(markdownToIR("-\t  code").listItems?.[0]?.sourceIndent).toBe(2);
});

it("indexes lone carriage returns like the CommonMark parser", () => {
  const source = "- one\r- two";
  const items = markdownToIR(source).listItems ?? [];

  expect(items.map((item) => item.sourceMarker?.start)).toEqual([0, 6]);
  expect(
    items.map((item) => source.slice(item.sourceMarker?.start, item.sourceMarker?.end)),
  ).toEqual(["-", "-"]);
});

it.each<[string, MarkdownIR]>([
  ["(__warning__)", plainIR("(warning)", [makeStyle(1, 8, "bold")])],
  [
    "[obj.__class__]\n\n[obj.__class__]: https://example.org/python",
    plainIR("obj.__class__", [], [makeLink(0, 13, "https://example.org/python")]),
  ],
])("preserves dunder identifiers in %s", (source, expected) => {
  expect(
    markdownToIR(source, {
      autolink: false,
      linkify: false,
      preserveDunderIdentifiers: true,
    }),
  ).toEqual(expected);
});

function styledText(markdown: string): string[] {
  const ir = markdownToIR(markdown);
  return ir.styles
    .filter((span) => span.style === "bold")
    .map((span) => ir.text.slice(span.start, span.end));
}

it("handles supplementary CJK and variation selectors at emphasis boundaries", () => {
  expect(styledText("𰻞𰻞**（ビャンビャン）**麺")).toEqual(["（ビャンビャン）"]);
  expect(styledText("葛󠄀**(こちらが正式表記)**城市")).toEqual(["(こちらが正式表記)"]);
});

it.each<[string, number]>([
  ["Use `one` and ``two`` ticks with ~~old~~ prose.", 0],
  ["```ts", 0],
  ["~~~ts\nconst answer = 42;\n~~~", 18],
])("counts fenced body characters in %j", (text, count) => {
  expect(countMarkdownFencedCodeChars(text)).toBe(count);
});

function collectRenderedLinks(ir: MarkdownIR) {
  const links: Array<{ href: string; label: string; origin: "authored" | "linkify" }> = [];
  renderMarkdownWithMarkers(ir, {
    styleMarkers: {},
    escapeText: (text) => text,
    buildLink: (link, text, context) => {
      links.push({
        href: link.href,
        label: text.slice(link.start, link.end),
        origin: context.origin,
      });
      return null;
    },
  });
  return links;
}

it("keeps provenance out of the public link span while exposing it to renderers", () => {
  const ir = markdownToIR("README.md [main.ts](https://main.ts)");

  expect(ir.links).toEqual([
    { start: 0, end: 9, href: "http://README.md" },
    { start: 10, end: 17, href: "https://main.ts" },
  ]);
  expect(collectRenderedLinks(ir)).toEqual([
    { href: "http://README.md", label: "README.md", origin: "linkify" },
    { href: "https://main.ts", label: "main.ts", origin: "authored" },
  ]);
});

const metadataKeys = ["styles", "links", "annotations", "listItems", "blocks", "htmlTags"] as const;
function mapMetadata(ir: MarkdownIR, map: (entries: unknown[]) => unknown[]) {
  for (const key of metadataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(ir, key);
    const value: unknown = descriptor?.value;
    if (Array.isArray(value)) {
      Object.defineProperty(ir, key, { ...descriptor, value: map(value) });
    }
  }
}

function longDocument(): IRWithMetadata {
  const source = Array.from(
    { length: 128 },
    (_, index) =>
      `## heading ${index}\n\n- **bold ${index}** [label ${index}](https://example.com/${index}) ` +
      `<span title="item">tail ${index}</span> https://example.net/${index}\n\n` +
      `[2026-07-02] assistant: note ${index}\n`,
  ).join("\n");
  return markdownToIR(source, {
    headingStyle: "rich",
    linkify: true,
    assistantTranscriptRoleHeaders: true,
  });
}

function countMetadataReads(ir: MarkdownIR) {
  let reads = 0;
  let entries = 0;
  mapMetadata(ir, (value) => {
    entries += value.length;
    return new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          reads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  });
  return { entries, reads: () => reads };
}

function projectMetadata(ir: MarkdownIR) {
  return {
    ...ir,
    links: ir.links.map((link) => ({ ...link, autoLinked: isAutoLinkedMarkdownLink(link) })),
    listItems: ir.listItems?.map((item) => Object.getOwnPropertyDescriptors(item)),
    blocks: Object.getOwnPropertyDescriptor(ir, "blocks"),
    htmlTags: Object.getOwnPropertyDescriptor(ir, "htmlTags"),
  };
}

function expectSlicedMetadata(chunks: MarkdownIR[], reference: MarkdownIR) {
  let cursor = 0;
  const expected = chunks.map((chunk) => {
    const start = reference.text.indexOf(chunk.text, cursor);
    expect(start).toBeGreaterThanOrEqual(cursor);
    cursor = start + chunk.text.length;
    return sliceMarkdownIR(reference, start, cursor);
  });
  expect(chunks.map(projectMetadata)).toEqual(expected.map(projectMetadata));
}

it.each(["plain", "rendered"] as const)("partitions metadata without rescanning: %s", (mode) => {
  const reference = longDocument();
  const input = longDocument();
  expect(metadataKeys.every((key) => (reference[key]?.length ?? 0) > 0)).toBe(true);
  const count = countMetadataReads(input);
  const limit = 96;
  const chunks =
    mode === "plain"
      ? chunkMarkdownIR(input, limit)
      : renderMarkdownIRChunksWithinLimit({
          ir: input,
          limit,
          renderChunk: (chunk) => chunk.text,
          measureRendered: (rendered) => rendered.length,
        }).map((chunk) => chunk.source);
  const metadataReads = count.reads();

  expect(chunks.length).toBeGreaterThan(128);
  expect(chunks.every((chunk) => chunk.text.length <= limit)).toBe(true);
  if (mode === "plain") {
    expect(chunks.map((chunk) => chunk.text)).toEqual(chunkText(reference.text, limit));
  } else {
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(reference.text);
  }
  expectSlicedMetadata(chunks, reference);
  expect(projectMetadata(input)).toEqual(projectMetadata(reference));
  expect(metadataReads).toBeLessThanOrEqual(count.entries * 4 + chunks.length * 12);
});

it("keeps unsorted and duplicated metadata independent across chunks", () => {
  const input = longDocument();
  mapMetadata(input, (value) => {
    const reversed = value.toReversed();
    return [...reversed, ...reversed.slice(0, 1)];
  });
  const before = structuredClone(projectMetadata(input));
  const chunks = chunkMarkdownIR(input, 96);
  expect(chunks.length).toBeGreaterThan(128);
  expectSlicedMetadata(chunks, input);
  const links = chunks.flatMap((chunk) => chunk.links);
  expect(new Set(links).size).toBe(links.length);
  expect(links.every((link) => !input.links.includes(link))).toBe(true);
  const first = links[0];
  expect(first).toBeDefined();
  if (first) {
    first.href = "https://example.org/changed";
  }
  expect(projectMetadata(input)).toEqual(before);
});

it("handles empty parent with nested items", () => {
  expect(markdownToIR("-\n  - Nested only\n- Normal").text).toContain("  • Nested only");
});

it.each<[string, string, Parameters<typeof markdownToIR>[1]?]>([
  ["> quote\n\nparagraph", "> quote\n\nparagraph", { blockquotePrefix: "> " }],
  ["- Item 1\n- ---\n- Item 2", "• Item 1\n\n───\n\n• Item 2"],
  ["- Run this:\n  ```sh\n  echo hello\n  ```\n- Done", "• Run this:\necho hello\n• Done"],
  ["1. Intro\n   # Heading\n   Details\n2. Done", "1. Intro\nHeading\n\nDetails\n2. Done"],
  [
    "- > First paragraph\n  >\n  > Second paragraph\n- Next",
    "• First paragraph\n\nSecond paragraph\n• Next",
  ],
  [
    "- first paragraph\n\n  second paragraph\n- next",
    "• first paragraph\n\nsecond paragraph\n\n• next",
  ],
  ["- parent\n\n  - child\n\n- next", "• parent\n\n  • child\n• next"],
])("preserves block/list paragraph spacing in %j", (markdown, expected, options) => {
  expect(markdownToIR(markdown, options).text).toBe(expected);
});

it("does not linkify URLs inside raw HTML tag attributes", () => {
  const source =
    '<img src="https://example.com/diagram.png" alt="Diagram"> https://example.com/page';
  const ir = markdownToIR(source);
  expect(ir.text).toBe(source);
  expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
    "https://example.com/page",
  ]);
});

const opening = '<b title="Example\nuser[Thu] note">';
const imageLabel = "<b>diagram</b>";
it.each<[string, MarkdownIR, Parameters<typeof markdownToIR>[1]?]>([
  [
    `${opening}**body**</b>`,
    {
      ...plainIR(`${opening}body</b>`, [makeStyle(opening.length, opening.length + 4, "bold")]),
      htmlTags: [
        htmlTag(0, opening.length, opening, "b"),
        htmlTag(opening.length + 4, opening.length + 8, "</b>", "b", true),
      ],
    },
    { enableSpoilers: true, assistantTranscriptRoleHeaders: true, linkify: false },
  ],
  ["<b[&#114;](https://example.com)>tail", plainIR("<br>tail", [], [makeLink(2, 3)])],
  [
    `before **![${imageLabel}](https://example.com/diagram.png)** after`,
    plainIR(`before ${imageLabel} after`, [makeStyle(7, 7 + imageLabel.length, "bold")]),
  ],
  [
    "before <b>x</b> ||<i>y</i>|| after",
    {
      ...plainIR("before <b>x</b> <i>y</i> after", [makeStyle(16, 24, "spoiler")]),
      htmlTags: [
        htmlTag(7, 10, "<b>", "b"),
        htmlTag(11, 15, "</b>", "b", true),
        htmlTag(16, 19, "<i>", "i"),
        htmlTag(20, 24, "</i>", "i", true),
      ],
    },
    { enableSpoilers: true },
  ],
])("preserves authored HTML provenance: %s", (source, expected, options) => {
  const ir = markdownToIR(source, options);
  expect({ ...ir, htmlTags: ir.htmlTags }).toEqual({ ...expected, htmlTags: expected.htmlTags });
});

it("transfers only whole tags with the text's complete code points", () => {
  const source = markdownToIR("a🐱<b>x</b>");
  const sliced = sliceMarkdownIR(source, 2, 6);
  const target = markdownToIR("prefix");
  appendMarkdownIR(target, sliced);

  expect(sliced.text).toBe("🐱<b>");
  expect(target).toMatchObject({ text: "prefix🐱<b>", htmlTags: [htmlTag(8, 11, "<b>", "b")] });
  expect(source.htmlTags?.[0]?.start).toBe(3);
  expect(sliceMarkdownIR(source, 4, 6).htmlTags).toBeUndefined();
  expect(Object.keys(target)).not.toContain("htmlTags");
  expect(JSON.stringify(target)).not.toContain("htmlTags");
});

it("does not turn chunked tag fragments into authored tags", () => {
  const chunks = renderMarkdownIRChunksWithinLimit({
    ir: markdownToIR("a<b>x</b>"),
    limit: 4,
    measureRendered: (text: string) => text.length,
    renderChunk: (ir) => ir.text,
  });

  expect(chunks.map(({ rendered, source }) => ({ rendered, tags: source.htmlTags }))).toEqual([
    {
      rendered: "a<b>",
      tags: [htmlTag(1, 4, "<b>", "b")],
    },
    { rendered: "x</b", tags: undefined },
    { rendered: ">", tags: undefined },
  ]);
});

it("carries authored tags through table cells and bullet projection", () => {
  const source = "| Value |\n| --- |\n| **<b>x</b>** |";
  const { tables } = markdownToIRWithMeta(source, { tableMode: "block" });
  const cell = tables[0]?.rowCells[0]?.[0];
  expect(cell).toMatchObject({
    text: "<b>x</b>",
    htmlTags: [htmlTag(0, 3, "<b>", "b"), htmlTag(4, 8, "</b>", "b", true)],
  });
  expect(Object.keys(cell ?? {})).not.toContain("htmlTags");
  const bullets = markdownToIR(source, { tableMode: "bullets" });
  expect(bullets).toMatchObject({
    text: "• Value: <b>x</b>",
    htmlTags: [htmlTag(9, 12, "<b>", "b"), htmlTag(13, 17, "</b>", "b", true)],
  });
});

it("preserves code-owned table cell edges surrounded by ordinary whitespace", () => {
  const { tables } = markdownToIRWithMeta("| V |\n| --- |\n| &nbsp;` `&nbsp; |", {
    tableMode: "block",
  });

  expect(tables[0]?.rowCells[0]?.[0]).toEqual(plainIR(" ", [makeStyle(0, 1, "code")]));
});

it("projects UTF-16 formatting boundaries through insertion, replacement, and removal", () => {
  const result = applyMarkdownTextEdits("😀 abc tail", [
    { start: 7, end: 11, text: "" },
    { start: 0, end: 0, text: "#" },
    { start: 3, end: 6, text: "`abc`" },
  ]);

  expect(result.text).toBe("#😀 `abc` ");
  expect([0, 2, 3, 6, 7, 11].map(result.mapOffset)).toEqual([1, 3, 4, 9, 10, 10]);
  expect(result.text.slice(result.mapOffset(3), result.mapOffset(6))).toBe("`abc`");
});

it("keeps equal-position insertions in caller order and leaves an empty projection unchanged", () => {
  const result = applyMarkdownTextEdits("XY", [
    { start: 1, end: 1, text: "first" },
    { start: 1, end: 1, text: "second" },
  ]);

  expect(result.text).toBe("XfirstsecondY");
  expect(result.mapOffset(1)).toBe(12);
  const unchanged = applyMarkdownTextEdits("😀XY", []);
  expect(unchanged.text).toBe("😀XY");
  expect(unchanged.mapOffset(2)).toBe(2);
});
