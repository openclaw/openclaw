import { describe, expect, it } from "vitest";
import { buildCodeSpanIndex } from "./code-spans.js";
import {
  findMarkdownCodeRegions,
  findMarkdownCodeSpans,
  parseMarkdownOwnership,
} from "./reasoning-tags.js";

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
    {
      name: "accepts alternate fence markers and unterminated trailing fences",
      text: "~~~js\nconsole.log(1)\n~~~\nplain\n```\nunterminated",
      expectedSlices: ["~~~js\nconsole.log(1)\n~~~", "```\nunterminated"],
    },
    {
      name: "keeps adjacent inline code outside fenced regions",
      text: ["```ts", "const a = 1;", "```", "after `inline` tail"].join("\n"),
      expectedSlices: ["```ts\nconst a = 1;\n```", "`inline`"],
    },
  ] as const)("$name", ({ text, expectedSlices }) => {
    expectCodeRegionSlices(text, expectedSlices);
  });

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

  it("matches a whole parse while a streamed reply grows past settled blocks", () => {
    // Option calls bypass the streaming caches, and gfm is the default syntax.
    const whole = { syntax: "gfm" } as const;
    const text = [
      "Settled paragraph with `code` that the stream reuses.\n\n".repeat(6),
      "    indented code\n\n2) not a list after indented code\n\n",
      "Lead\n\n* \n\n\tTab code\n\n    more code\n\n",
      "> # Note\n    code\n2. ```\n   MEDIA: ./a.png\n   ```\n\n",
      "> |a|b|\n> |-|-|\n|`c|d`|\n\n",
      "Lead line\r\nHeader cell\r\n|---|---|\r\n\r\n",
      "Para\n\n\uFEFFbom with `code`\n\n",
      "See ![`[[audio_as_voice]]`][ref] here.\n\nMore.\n\n[ref]: https://example.invalid/a.png\n\n",
      "Tail with `code`.",
    ].join("");
    // Stream every prefix, then continue each line start differently, which can
    // change how earlier lines parse.
    for (const fork of ["", "2. ```\nx\n```\n", "|-|-|\n", "#tag\n"]) {
      for (let end = 1; end <= text.length; end += 1) {
        const prefix = text.slice(0, end);
        if (fork && !/[\r\n]$/u.test(prefix)) {
          continue;
        }
        const candidate = prefix + fork;
        expect(parseMarkdownOwnership(candidate)).toEqual(parseMarkdownOwnership(candidate, whole));
        expect(findMarkdownCodeRegions(candidate)).toEqual(
          findMarkdownCodeRegions(candidate, whole),
        );
      }
    }
  });

  it("matches a whole parse when a streamed line that began with indentation is rewritten", () => {
    const head = `${"Settled paragraph with `code` that the stream reuses.\n\n".repeat(6)}Para\n\n`;
    const streamed = `${head} \tcode after a space\n\nMore.\n`;
    for (let end = 1; end <= streamed.length; end += 1) {
      parseMarkdownOwnership(streamed.slice(0, end));
    }
    const rewritten = `${head} \n\nx`;
    expect(parseMarkdownOwnership(rewritten)).toEqual(
      parseMarkdownOwnership(rewritten, { syntax: "gfm" }),
    );
  });
});
