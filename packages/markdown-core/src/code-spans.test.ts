import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex } from "./code-spans.js";
import { findMarkdownCodeRegions, findMarkdownCodeSpans } from "./reasoning-tags.js";

describe("buildCodeSpanIndex", () => {
  it("includes opening delimiters and excludes ends in either query direction", () => {
    const text = "~~~\nfenced\n~~~\n`inline` tail";
    const index = buildCodeSpanIndex(text);

    expect(
      [text.lastIndexOf("`") + 1, 0, text.indexOf("`"), text.lastIndexOf("~~~") + 3, 0].map(
        index.isInside,
      ),
    ).toEqual([false, true, true, false, true]);
  });
});

describe("markdown-core code spans", () => {
  function expectCodeRegionSlices(text: string, expectedSlices: readonly string[]) {
    const regions = findMarkdownCodeSpans(text);
    expect(regions).toHaveLength(expectedSlices.length);
    expect(regions.map(([start, end]) => text.slice(start, end))).toEqual(expectedSlices);
  }

  it.each([
    {
      name: "finds fenced and inline code regions without double-counting inline code inside fences",
      text: ["before `inline` after", "```ts", "const a = `inside fence`;", "```", "tail"].join(
        "\n",
      ),
      expectedSlices: ["`inline`", "```ts\nconst a = `inside fence`;\n```"],
    },
  ] as const)("$name", ({ text, expectedSlices }) => {
    expectCodeRegionSlices(text, expectedSlices);
  });

  it.each([
    {
      name: "does not turn HTML code tags or decoded entities into Markdown code",
      text: "<code>literal</code>\n<pre>literal</pre>\n&#96;literal&#96;\n&Tab;literal",
      expectedSlices: [],
    },
  ] as const)("follows CommonMark block ownership: $name", ({ text, expectedSlices }) => {
    expectCodeRegionSlices(text, expectedSlices);
  });

  it.each([
    { text: "\t  A\n\n\tB", value: "  A\n\nB", nested: false },
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
