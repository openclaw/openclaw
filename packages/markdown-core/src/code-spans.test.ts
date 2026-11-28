import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex, createInlineCodeState } from "./code-spans.js";
import { findMarkdownCodeRegions } from "./reasoning-tags.js";

describe("buildCodeSpanIndex", () => {
  it("supports backward queries over inline code that encloses a fence", () => {
    const text = "`open\n~~~\ninside\n~~~\nafter` tail";
    const index = buildCodeSpanIndex(text);

    expect(
      [text.length, text.indexOf("after"), text.indexOf("~~~"), 0, text.indexOf("tail")].map(
        index.isInside,
      ),
    ).toEqual([false, true, true, true, false]);
  });

  it("includes opening delimiters and excludes ends in either query direction", () => {
    const text = "~~~\nfenced\n~~~\n`inline` tail";
    const index = buildCodeSpanIndex(text);

    expect(
      [text.lastIndexOf("`") + 1, 0, text.indexOf("`"), text.lastIndexOf("~~~") + 3, 0].map(
        index.isInside,
      ),
    ).toEqual([false, true, true, false, true]);
  });

  it("keeps an inline backtick run intact when a chunk boundary splits it", () => {
    const text = "`` ``";
    const expected = buildCodeSpanIndex(text);
    const first = buildCodeSpanIndex("`", createInlineCodeState());
    const second = buildCodeSpanIndex("` ``", first.inlineState);

    expect(expected.isInside(2)).toBe(true);
    expect(second.isInside(1)).toBe(expected.isInside(2));
    expect(second.inlineState.open).toBe(false);
  });

  it("carries a split backtick run across an empty chunk", () => {
    const first = buildCodeSpanIndex("`", createInlineCodeState());
    const empty = buildCodeSpanIndex("", first.inlineState);
    const last = buildCodeSpanIndex("` ``", empty.inlineState);

    expect(last.isInside(1)).toBe(true);
    expect(last.inlineState.open).toBe(false);
  });

  it.each(["x````b", "``a`b``", "\\` literal", "`one` ``two``"])(
    "matches the one-shot index for one-character chunks: %j",
    (text) => {
      const expected = buildCodeSpanIndex(text);
      let state = createInlineCodeState();
      for (let offset = 0; offset < text.length; offset += 1) {
        const chunk = text.charAt(offset);
        const index = buildCodeSpanIndex(chunk, state);
        expect(index.isInside(0), `offset ${offset} in ${JSON.stringify(text)}`).toBe(
          expected.isInside(offset),
        );
        state = index.inlineState;
      }
      expect(state.open).toBe(expected.inlineState.open);
      expect(state.ticks).toBe(expected.inlineState.ticks);
    },
  );

  it.each(["opener", "closer"])("tracks a mid-line %s split with both scanner states", (kind) => {
    const text = "note: ``word`` after";
    const cut = (kind === "opener" ? text.indexOf("``") : text.lastIndexOf("``")) + 1;
    const first = buildCodeSpanIndex(text.slice(0, cut));
    const second = buildCodeSpanIndex(text.slice(cut), first.inlineState, first.fenceState);
    const word = text.indexOf("word");

    expect(word < cut ? first.isInside(word) : second.isInside(word - cut)).toBe(true);
    expect(second.isInside(text.indexOf("after") - cut)).toBe(false);
  });
});

describe("markdown-core code spans", () => {
  function expectCodeRegionSlices(text: string, expectedSlices: readonly string[]) {
    const regions = findMarkdownCodeRegions(text).map(({ start, end }) => [start, end] as const);
    expect(regions).toHaveLength(expectedSlices.length);
    expect(regions.map(([start, end]) => text.slice(start, end))).toEqual(expectedSlices);
  }

  it.each([
    {
      name: "requires equal backtick runs",
      text: "before ```<think>private</think>`` after",
      expectedSlices: [],
    },
    {
      name: "keeps shorter runs inside a matching code span",
      text: "before ``a`b`` after",
      expectedSlices: ["``a`b``"],
    },
    {
      name: "does not carry inline code from a paragraph into a list",
      text: "paragraph `open\n- item `close",
      expectedSlices: [],
    },
    {
      name: "allows inline code across soft line breaks in one paragraph",
      text: "paragraph `open\ncontinued` tail",
      expectedSlices: ["`open\ncontinued`"],
    },
    {
      name: "does not treat escaped backticks as delimiters",
      text: "before \\`not code\\` after",
      expectedSlices: [],
    },
    {
      name: "does not join backticks across link destinations",
      text: "[label](url`x) plain (y`) after",
      expectedSlices: [],
    },
    {
      name: "finds inline code inside GFM table cells",
      text: "| a | b |\n| - | - |\n| `code` | y |",
      expectedSlices: ["`code`"],
    },
    {
      name: "finds fenced code nested in blockquotes",
      text: "> ```xml\n> literal\n> ```",
      expectedSlices: ["```xml\n> literal\n> ```"],
    },
    {
      name: "finds indented code blocks",
      text: "    literal",
      expectedSlices: ["    literal"],
    },
    {
      name: "finds tilde fences without backticks",
      text: "~~~\nliteral\n~~~",
      expectedSlices: ["~~~\nliteral\n~~~"],
    },
    {
      name: "finds tab-indented code blocks",
      text: "\tliteral",
      expectedSlices: ["\tliteral"],
    },
    {
      name: "finds indented code inside blockquotes",
      text: ">     literal",
      expectedSlices: ["    literal"],
    },
    {
      name: "finds indented code inside list items",
      text: "- item\n\n      literal",
      expectedSlices: ["    literal"],
    },
    {
      name: "does not interpret short or Unicode indentation as code",
      text: "   literal\n\n\u00a0\u00a0\u00a0\u00a0literal\n\n\u2003\u2003\u2003\u2003literal",
      expectedSlices: [],
    },
    {
      name: "does not turn HTML code tags or decoded entities into Markdown code",
      text: "<code>literal</code>\n<pre>literal</pre>\n&#96;literal&#96;\n&Tab;literal",
      expectedSlices: [],
    },
  ] as const)("follows CommonMark block ownership: $name", ({ text, expectedSlices }) => {
    expectCodeRegionSlices(text, expectedSlices);
  });

  it.each([
    { text: "    A\n\n    B", value: "A\n\nB", nested: false },
    { text: "\t  A\n\n\tB", value: "  A\n\nB", nested: false },
    { text: ">     A\n>\n>     B", value: "A\n\nB", nested: true },
    { text: "- item\n\n      A\n\n      B", value: "A\n\nB", nested: true },
  ])(
    "maps authored indented content without container syntax: $text",
    ({ text, value, nested }) => {
      const ordinary = findMarkdownCodeRegions(text);
      const regions = findMarkdownCodeRegions(text, { includeIndentedSource: true });
      expect(regions.map(({ start, end, block }) => ({ start, end, block }))).toEqual(ordinary);
      expect(regions).toHaveLength(1);
      const region = regions[0];
      if (!region?.indentedSource) {
        throw new Error("Expected parser-owned indented source metadata");
      }
      const source = region.indentedSource;
      expect(source.value).toBe(value);
      expect(source.nested).toBe(nested);
      for (const character of ["A", "B"]) {
        const at = text.indexOf(character) - region.start;
        expect(source.value.slice(source.offsets[at], source.offsets[at + 1])).toBe(character);
      }
    },
  );

  it("retains inline source ownership when indented source mapping is also requested", () => {
    const text = "Use `A\nB` here.\n\n    C";
    const inline = findMarkdownCodeRegions(text, { includeSource: true }).filter(
      (region) => !region.block,
    );
    expect(
      findMarkdownCodeRegions(text, {
        includeSource: true,
        includeIndentedSource: true,
      }).filter((region) => !region.block),
    ).toEqual(inline);
  });

  it("walks deeply nested Markdown without exhausting the JavaScript stack", () => {
    const input = `${"> ".repeat(10_000)}\`<think>x</think>\``;

    expectCodeRegionSlices(input, ["`<think>x</think>`"]);
  });
});
