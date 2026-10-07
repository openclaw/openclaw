import { describe, expect, it } from "vitest";
import { chunkText, chunkTextRanges } from "./chunk-text.js";
import type { MarkdownIRWithMetadata, MarkdownListItemWithMetadata } from "./ir-metadata.js";
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
import { convertMarkdownTables } from "./tables.js";

type IRWithMetadata = Omit<MarkdownIRWithMetadata, "listItems"> & {
  listItems?: MarkdownListItemWithMetadata[];
};
const markdownToIR: (...args: Parameters<typeof parseMarkdownToIR>) => IRWithMetadata =
  parseMarkdownToIR;
const sliceMarkdownIR: (...args: Parameters<typeof sliceParsedMarkdownIR>) => IRWithMetadata =
  sliceParsedMarkdownIR;

const href = "https://example.com";

function expectWellFormedUtf16(text: string): void {
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
}

describe("markdownToIR", () => {
  it("keeps document references and changed options local to each parse", () => {
    const options = { linkify: false };
    expect(
      markdownToIR("[ref]: https://example.org/doc\n\n[ref]", options).links.map(
        (link) => link.href,
      ),
    ).toEqual(["https://example.org/doc"]);
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);
    options.linkify = true;
    expect(markdownToIR("[ref] example.org", options).links.map((link) => link.href)).toEqual([
      "http://example.org",
    ]);
    options.linkify = false;
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);
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
      expect(sliced.text).toBe(expected);
      expect(sliced.styles).toEqual([{ start: 0, end: expected.length, style: "bold" }]);
      expect(sliced.links).toEqual([{ start: 0, end: expected.length, href }]);
    }
  });

  it("aligns linked styles when a negative slice start bisects a surrogate pair", () => {
    const ir = markdownToIR("a[**😀b**](https://example.com)");
    const sliced = sliceMarkdownIR(ir, -2, ir.text.length);
    expect(sliced.text).toBe("😀b");
    expectWellFormedUtf16(sliced.text);
    expect(sliced.links).toEqual([{ start: 0, end: 3, href }]);
    expect(sliced.styles).toEqual([{ start: 0, end: 3, style: "bold" }]);
  });

  it("keeps transcript annotations and links aligned with the expanded end", () => {
    const ir = markdownToIR("user[Thu 2026-07-02] **A😀B** [C🐱D](https://example.com)", {
      assistantTranscriptRoleHeaders: true,
    });
    const catStart = ir.text.indexOf("🐱");
    const sliced = sliceMarkdownIR(ir, 0, catStart + 1);
    expect(catStart).toBeGreaterThan(0);
    expect(sliced.text).toBe(ir.text.slice(0, catStart + 2));
    expectWellFormedUtf16(sliced.text);
    expect(sliced.annotations).toEqual(ir.annotations);
    expect(sliced.styles).toEqual(ir.styles);
    expect(sliced.links).toEqual([{ start: ir.links[0]?.start, end: sliced.text.length, href }]);
  });

  it("rejoins surrogate-safe transport chunks without duplicating emoji", () => {
    const ir = markdownToIR("a😀b🐱c");
    for (const mode of ["hard", "preferred"] as const) {
      for (const limit of [1, 2, 3, 4]) {
        const chunks = chunkTextRanges(ir.text, { limit, mode }).map(({ start, end }) =>
          sliceMarkdownIR(ir, start, end),
        );
        for (const chunk of chunks) {
          expectWellFormedUtf16(chunk.text);
        }
        expect(chunks.map((chunk) => chunk.text).join("")).toBe(ir.text);
      }
    }
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
    expect(ir).toEqual({
      text,
      styles: [{ start: 0, end: text.length, style: "code_block" }],
      links: [],
    });
  });

  it("fences converted code tables with aligned short and empty columns", () => {
    expect(
      convertMarkdownTables(
        "| | A | BB | Long |\n| --- | --- | --- | --- |\n| | 1 | 22 | data |",
        "code",
      ),
    ).toBe(
      "```\n|     | A   | BB  | Long |\n| --- | --- | --- | ---- |\n|     | 1   | 22  | data |\n```",
    );
  });

  it("emits underline spans only for authored u and ins tags when enabled", () => {
    const ir = markdownToIR("<u>under <ins>nested</ins></u> and __bold__", {
      enableHtmlUnderline: true,
    });
    expect(ir.text).toBe("under nested and bold");
    expect(ir.styles).toEqual([
      { start: 0, end: 12, style: "underline" },
      { start: 17, end: 21, style: "bold" },
    ]);
  });

  it("keeps other HTML lexemes opaque without enabling HTML block parsing", () => {
    const ir = markdownToIR('<div title="<u>">\n**bold**\n<!-- <u> -->\n</div>', {
      enableHtmlUnderline: true,
    });
    expect(ir.text).toBe('<div title="<u>">\nbold\n<!-- <u> -->\n</div>');
    expect(ir.styles).toEqual([{ start: 18, end: 22, style: "bold" }]);
  });
});

describe("markdownToIR block metadata", () => {
  it("records whether a fenced block owns an explicit closing fence", () => {
    const ir = markdownToIR("```ts\nunclosed");
    const empty = markdownToIR("```ts");
    const overIndented = markdownToIR("```\n    ```");
    const tabIndented = markdownToIR("```\n\t```");
    const unmatchedQuote = markdownToIR("```\n> ```");
    const listed = markdownToIR("- ```\n  code\n  ```");
    const quoted = markdownToIR("> ```\n> code\n> ```");
    const listThenQuote = markdownToIR("10. >   ```\n    >   code\n    >   ```");
    const alternating = markdownToIR("> - > 10. ```\n>   >     code\n>   >     ```");
    const independentFenceIndent = markdownToIR("- item\n   ```\n   code\n  ```");
    const tabQuoted = markdownToIR(">\t```\n>\tcode\n>\t```");
    const paddedList = markdownToIR("   - ```\n     code");

    expect(ir.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(empty.blocks?.[0]).toMatchObject({
      start: 0,
      end: 1,
      codeOrigin: "fenced",
      codeClosed: false,
    });
    expect(overIndented.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(tabIndented.blocks?.[0]).toMatchObject({ codeOrigin: "fenced", codeClosed: false });
    expect(unmatchedQuote.blocks?.[0]).toMatchObject({
      codeOrigin: "fenced",
      codeClosed: false,
    });
    expect(listed.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 2,
    });
    expect(quoted.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 2,
    });
    expect(listThenQuote.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 3,
    });
    expect(alternating.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      depth: 5,
    });
    expect(
      independentFenceIndent.blocks?.find((block) => block.kind === "code_block"),
    ).toMatchObject({ codeClosed: true });
    expect(tabQuoted.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: true,
      blockquoteDepth: 1,
    });
    expect(paddedList.blocks?.find((block) => block.kind === "code_block")).toMatchObject({
      codeClosed: false,
    });
  });

  it("records setext headings and thematic breaks without changing rendered bytes", () => {
    const ir = markdownToIR("setext\n---\n\n***", { horizontalRuleText: "" });

    expect(ir.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "heading", headingOrigin: "setext", headingLevel: 2 }),
        expect.objectContaining({
          kind: "thematic_break",
          start: ir.text.length,
          end: ir.text.length,
        }),
      ]),
    );
  });

  it("does not mark block content on the marker line as marker-only", () => {
    const fenced = markdownToIR("- ```\n  code\n  ```").listItems?.[0];
    const quoted = markdownToIR("- > quote").listItems?.[0];

    expect(fenced).toBeDefined();
    expect(fenced?.markerOnly).toBeUndefined();
    expect(quoted).toBeDefined();
    expect(quoted?.markerOnly).toBeUndefined();
    const thematic = markdownToIR("- ***", { horizontalRuleText: "" }).listItems?.[0];
    expect(thematic).toBeDefined();
    expect(thematic?.markerOnly).toBeUndefined();
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
});

describe("blockquote spacing", () => {
  it("excludes the trailing paragraph separator from the blockquote span", () => {
    expect(markdownToIR("> `gpt`\n\nbody")).toEqual({
      text: "gpt\n\nbody",
      styles: [
        { start: 0, end: 3, style: "blockquote" },
        { start: 0, end: 3, style: "code" },
      ],
      links: [],
    });
  });

  it("includes the configured prefix without adding spacing", () => {
    expect(markdownToIR("> quote\n\nparagraph", { blockquotePrefix: "> " }).text).toBe(
      "> quote\n\nparagraph",
    );
  });
});

describe("chunkMarkdownIR", () => {
  it("keeps the final in-limit remainder together after a soft break", () => {
    const ir: MarkdownIR = {
      text: "abcdefgh ij kl",
      styles: [],
      links: [],
    };

    expect(chunkMarkdownIR(ir, 10).map((chunk) => chunk.text)).toEqual(["abcdefgh", "ij kl"]);
  });
});

const DUNDER_OPTIONS = {
  autolink: false,
  linkify: false,
  preserveDunderIdentifiers: true,
} as const;

describe("markdownToIR preserveDunderIdentifiers", () => {
  it("keeps ordinary parenthesized bold unchanged when enabled", () => {
    expect(markdownToIR("(__warning__)", DUNDER_OPTIONS)).toEqual({
      text: "(warning)",
      styles: [{ start: 1, end: 8, style: "bold" }],
      links: [],
    });
  });

  it("preserves shortcut reference links", () => {
    const source = "[obj.__class__]\n\n[obj.__class__]: https://example.org/python";
    expect(markdownToIR(source, DUNDER_OPTIONS)).toEqual({
      text: "obj.__class__",
      styles: [],
      links: [{ start: 0, end: 13, href: "https://example.org/python" }],
    });
  });
});

function styledText(markdown: string): string[] {
  const ir = markdownToIR(markdown);
  return ir.styles
    .filter((span) => span.style === "bold")
    .map((span) => ir.text.slice(span.start, span.end));
}

describe("markdownToIR CJK emphasis flanking", () => {
  it("handles supplementary CJK and variation selectors at emphasis boundaries", () => {
    expect(styledText("𰻞𰻞**（ビャンビャン）**麺")).toEqual(["（ビャンビャン）"]);
    expect(styledText("葛󠄀**(こちらが正式表記)**城市")).toEqual(["(こちらが正式表記)"]);
  });

  it("treats ideographic space (U+3000) as whitespace, not a flanking CJK char", () => {
    // Opening delimiter followed by U+3000 must not be forced open.
    expect(styledText("前**\u3000加粗**后")).toEqual([]);
    // U+3000-separated emphasis keeps normal CommonMark behavior.
    expect(styledText("前\u3000**加粗**\u3000后")).toEqual(["加粗"]);
  });

  it("treats Unicode thin space (U+2009) as whitespace in delimiter scanning", () => {
    // Opening delimiter followed by U+2009 must not be forced open.
    expect(styledText("前**\u2009加粗**后")).toEqual([]);
    // Closing delimiter after CJK punctuation still closes when followed by U+2009.
    expect(styledText("前**加粗：**\u2009后")).toEqual(["加粗："]);
  });

  it("leaves code spans and links on their existing paths", () => {
    const code = markdownToIR("`前**加粗：**后`");
    expect(code.text).toBe("前**加粗：**后");
    expect(code.styles.map((span) => span.style)).toEqual(["code"]);

    const linked = markdownToIR("[前**加粗：**后](https://example.com)");
    expect(linked.text).toBe("前加粗：后");
    expect(linked.links).toEqual([
      { start: 0, end: linked.text.length, href: "https://example.com" },
    ]);
    expect(linked.styles.filter((span) => span.style === "bold")).toEqual([
      { start: 1, end: 4, style: "bold" },
    ]);
  });
});

describe("fenced code content length", () => {
  it.each([
    {
      name: "ordinary inline code and strikethrough",
      text: "Use `one` and ``two`` ticks with ~~old~~ prose.",
      count: 0,
    },
    { name: "unterminated empty fence", text: "```ts", count: 0 },
    { name: "tilde fence", text: "~~~ts\nconst answer = 42;\n~~~", count: 18 },
  ])("preserves body characters: $name", ({ text, count }) => {
    expect(countMarkdownFencedCodeChars(text)).toBe(count);
  });
});

describe("hr (thematic break) spacing", () => {
  it("renders between list items", () => {
    expect(markdownToIR("- Item 1\n- ---\n- Item 2").text).toBe("• Item 1\n\n───\n\n• Item 2");
  });
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

describe("markdownToIR link provenance", () => {
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
});

const metadataKeys = ["styles", "links", "annotations", "listItems", "blocks", "htmlTags"] as const;

function longDocument(): MarkdownIR {
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
  for (const key of metadataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(ir, key);
    const value: unknown = descriptor?.value;
    if (!Array.isArray(value)) {
      continue;
    }
    entries += value.length;
    Object.defineProperty(ir, key, {
      ...descriptor,
      value: new Proxy(value, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            reads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
  }
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

it.each(["plain", "rendered"] as const)(
  "partitions a long parsed document without rescanning unrelated metadata (%s)",
  (mode) => {
    const reference = longDocument();
    const input = longDocument();
    expect(
      metadataKeys.map((key) => {
        const value: unknown = Object.getOwnPropertyDescriptor(reference, key)?.value;
        return Array.isArray(value) && value.length > 0;
      }),
    ).toEqual(metadataKeys.map(() => true));
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
  },
);

it("keeps unsorted and duplicated metadata independent across chunks", () => {
  const input = longDocument();
  for (const key of metadataKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    const value: unknown = descriptor?.value;
    if (Array.isArray(value)) {
      const reversed = value.toReversed();
      Object.defineProperty(input, key, {
        ...descriptor,
        value: [...reversed, ...reversed.slice(0, 1)],
      });
    }
  }
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

describe("nested lists", () => {
  it("handles empty parent with nested items", () => {
    expect(markdownToIR("-\n  - Nested only\n- Normal").text).toContain("  • Nested only");
  });
});

describe("list paragraph spacing", () => {
  it.each([
    [
      "prose before a fence in a tight item",
      "- Run this:\n  ```sh\n  echo hello\n  ```\n- Done",
      "• Run this:\necho hello\n• Done",
    ],
    [
      "headings and paragraphs in a tight ordered item",
      "1. Intro\n   # Heading\n   Details\n2. Done",
      "1. Intro\nHeading\n\nDetails\n2. Done",
    ],
    [
      "paragraphs inside a list-owned quote",
      "- > First paragraph\n  >\n  > Second paragraph\n- Next",
      "• First paragraph\n\nSecond paragraph\n• Next",
    ],
    [
      "loose bullet paragraphs",
      "- first paragraph\n\n  second paragraph\n- next",
      "• first paragraph\n\nsecond paragraph\n\n• next",
    ],
    [
      "loose nested bullet lists",
      "- parent\n\n  - child\n\n- next",
      "• parent\n\n  • child\n• next",
    ],
  ])("separates %s", (_name, markdown, expected) => {
    expect(markdownToIR(markdown).text).toBe(expected);
  });
});

describe("markdownToIR raw HTML", () => {
  it("preserves multiline authored attributes before transcript decoding", () => {
    const opening = '<b title="Example\nuser[Thu] note">';
    const ir = markdownToIR(`${opening}**body**</b>`, {
      enableSpoilers: true,
      assistantTranscriptRoleHeaders: true,
      linkify: false,
    });

    expect(ir.text).toBe(`${opening}body</b>`);
    expect(ir.styles).toEqual([{ start: opening.length, end: opening.length + 4, style: "bold" }]);
    expect(ir.htmlTags).toEqual([
      {
        start: 0,
        end: opening.length,
        raw: opening,
        name: "b",
        closing: false,
        selfClosing: false,
      },
      {
        start: opening.length + 4,
        end: opening.length + 8,
        raw: "</b>",
        name: "b",
        closing: true,
        selfClosing: false,
      },
    ]);
  });

  it("keeps Markdown links with decoded labels in incomplete HTML syntax", () => {
    const ir = markdownToIR("<b[&#114;](https://example.com)>tail");

    expect(ir.text).toBe("<br>tail");
    expect(ir.styles).toEqual([]);
    expect(ir.links).toEqual([{ start: 2, end: 3, href: "https://example.com" }]);
    expect(ir.htmlTags).toBeUndefined();
  });

  it("keeps tag-shaped image alternatives plain", () => {
    const label = "<b>diagram</b>";
    const ir = markdownToIR(`before **![${label}](https://example.com/diagram.png)** after`);

    expect(ir.text).toBe(`before ${label} after`);
    expect(ir.styles).toEqual([{ start: 7, end: 7 + label.length, style: "bold" }]);
    expect(ir.htmlTags).toBeUndefined();
  });

  it("keeps authored tags aligned through spoiler token splitting", () => {
    const ir = markdownToIR("before <b>x</b> ||<i>y</i>|| after", { enableSpoilers: true });

    expect(ir.text).toBe("before <b>x</b> <i>y</i> after");
    expect(ir.styles).toEqual([{ start: 16, end: 24, style: "spoiler" }]);
    expect(ir.htmlTags).toEqual([
      { start: 7, end: 10, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 11, end: 15, raw: "</b>", name: "b", closing: true, selfClosing: false },
      { start: 16, end: 19, raw: "<i>", name: "i", closing: false, selfClosing: false },
      { start: 20, end: 24, raw: "</i>", name: "i", closing: true, selfClosing: false },
    ]);
  });

  it("transfers only whole tags with the text's complete code points", () => {
    const source = markdownToIR("a🐱<b>x</b>");
    const sliced = sliceMarkdownIR(source, 2, 6);
    const target = markdownToIR("prefix");
    appendMarkdownIR(target, sliced);

    expect(sliced.text).toBe("🐱<b>");
    expect(target.text).toBe("prefix🐱<b>");
    expect(target.htmlTags).toEqual([
      { start: 8, end: 11, raw: "<b>", name: "b", closing: false, selfClosing: false },
    ]);
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
        tags: [{ start: 1, end: 4, raw: "<b>", name: "b", closing: false, selfClosing: false }],
      },
      { rendered: "x</b", tags: undefined },
      { rendered: ">", tags: undefined },
    ]);
  });

  it("carries authored tags through table cells and bullet projection", () => {
    const source = "| Value |\n| --- |\n| **<b>x</b>** |";
    const { tables } = markdownToIRWithMeta(source, { tableMode: "block" });
    const cell = tables[0]?.rowCells[0]?.[0];
    expect(cell?.text).toBe("<b>x</b>");
    expect(cell?.htmlTags).toEqual([
      { start: 0, end: 3, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 4, end: 8, raw: "</b>", name: "b", closing: true, selfClosing: false },
    ]);
    expect(Object.keys(cell ?? {})).not.toContain("htmlTags");
    const bullets = markdownToIR(source, { tableMode: "bullets" });
    expect(bullets.text).toBe("• Value: <b>x</b>");
    expect(bullets.htmlTags).toEqual([
      { start: 9, end: 12, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 13, end: 17, raw: "</b>", name: "b", closing: true, selfClosing: false },
    ]);
  });
});

describe("markdownToIRWithMeta tableMode block", () => {
  it("preserves code-owned cell edges surrounded by ordinary whitespace", () => {
    const { tables } = markdownToIRWithMeta("| V |\n| --- |\n| &nbsp;` `&nbsp; |", {
      tableMode: "block",
    });

    expect(tables[0]?.rowCells[0]?.[0]).toEqual({
      text: " ",
      styles: [{ start: 0, end: 1, style: "code" }],
      links: [],
    });
  });
});

describe("applyMarkdownTextEdits", () => {
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

  it("applies boundary insertions before replacing the following source range", () => {
    const result = applyMarkdownTextEdits("AB", [
      { start: 1, end: 2, text: "XY" },
      { start: 1, end: 1, text: "b" },
    ]);

    expect(result.text).toBe("AbXY");
    expect([1, 2].map(result.mapOffset)).toEqual([2, 4]);
  });
});
