import stringWidth from "string-width";
import { assert, describe, expect, it } from "vitest";
import { measureInputRichBlocks, type InputRichBlock } from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

const blocksFor = (markdown: string) => markdownToTelegramRichBlocks(markdown).blocks;

const contains = expect.objectContaining;
const typed = (type: InputRichBlock["type"], fields: object = {}) => contains({ type, ...fields });
const details = (summary: unknown, blocks: unknown[]) =>
  contains({ type: "details", summary, blocks });
const paragraph = (text: unknown) => ({ type: "paragraph", text });
const image = (file: string) => `<img src="https://example.com/${file}"/>`;
const video = (file: string) => `<video src="https://example.com/${file}"></video>`;
const audio = (file: string) => `<audio src="https://example.com/${file}"></audio>`;

function single(markdown: string): InputRichBlock {
  const blocks = blocksFor(markdown);
  expect(blocks).toHaveLength(1);
  assert(blocks[0]);
  return blocks[0];
}

function expectLiteral(markdown: string, ...content: string[]) {
  const blocks = blocksFor(markdown);
  expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
  expectJson(blocks, content);
}
function expectJson(value: unknown, includes: string[], excludes: string[] = []) {
  const json = JSON.stringify(value);
  includes.forEach((text) => expect(json).toContain(text));
  excludes.forEach((text) => expect(json).not.toContain(text));
}

describe("block HTML islands", () => {
  it("keeps Markdown lists inside <details> islands", () => {
    const block = single("<details><summary>List</summary>\n\n- item A\n- item B\n\n</details>");
    expect(block).toMatchObject({
      type: "details",
      summary: "List",
      blocks: [{ type: "paragraph" }],
    });
    expectJson(block, ["• item A", "• item B"], ["<details>"]);
  });

  it("preserves styled HTML links and entity data (skip detection: true)", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      '<details><summary>More</summary><div><a href="https://example.com/**path**?q&#61;&quot;hi&quot;">**A &amp; &#38; &amp;amp; \\&amp; A   B\nC&nbsp;D**</a></div></details>',
      { skipEntityDetection: true },
    );
    const text = {
      type: "url",
      url: 'https://example.com/**path**?q="hi"',
      text: { type: "bold", text: "A & & &amp; &amp; A   B\nC\u00a0D" },
    };
    expect(blocks).toEqual([
      { type: "details", summary: "More", blocks: [{ type: "paragraph", text }] },
    ]);
    expect(plainText).toBe("More\nA & & &amp; &amp; A   B\nC\u00a0D");
  });

  it("preserves nested <details> containers around Markdown blocks", () => {
    const block = single(
      "<details><summary>Outer</summary>\n\n# Outer heading\n\n<details><summary>Inner</summary>\n\n# Inner heading\n\n```bash\nopenclaw doctor\n```\n\n> inner quote\n\n| item | done |\n| --- | --- |\n| **bold** | [link](https://openclaw.ai) |\n| `code` | *italic* |\n\n</details>\n\n> outer quote\n\n</details>",
    );
    assert(block.type === "details");
    expect(block.blocks.map(({ type }) => type)).toEqual(["heading", "details", "blockquote"]);
    const inner = block.blocks[1];
    assert(inner?.type === "details");
    expect(inner.summary).toBe("Inner");
    expect(JSON.stringify(inner.blocks[3])).toContain('"url":"https://openclaw.ai"');
    expect(inner.blocks.map(({ type }) => type)).toEqual(["heading", "pre", "blockquote", "table"]);
    expect(JSON.stringify(block)).not.toContain("<details>");
  });

  it.each<[string, unknown]>([
    [
      "<details><summary><code><summary></code>Title</summary>Body</details>",
      [details([{ type: "code", text: "<summary>" }, "Title"], [paragraph("Body")])],
    ],
    [
      "<details><details><summary>Inner</summary>\n\n# Inner heading\n\n</details></details>",
      [details("Details", [details("Inner", [typed("heading")])])],
    ],
    [
      "<details><summary>Outer</summary>\n\n> <details><summary>Inner</summary>\n>\n> # Inner heading\n>\n> </details>\n\n</details>",
      [details("Outer", [typed("blockquote", { blocks: [typed("details")] })])],
    ],
    [
      "<details open>\n<summary>Long <b>output</b></summary>\n<p>B</p>\n</details>",
      [
        typed("details", {
          is_open: true,
          summary: ["Long ", { type: "bold", text: "output" }],
          blocks: [paragraph("B")],
        }),
      ],
    ],
    [
      '<figure><img src="https://example.com/a.jpg"/><figcaption>Cap<cite>Src</cite></figcaption></figure>',
      [
        {
          type: "photo",
          photo: { type: "photo", media: "https://example.com/a.jpg" },
          caption: { text: "Cap", credit: "Src" },
        },
      ],
    ],
    [
      "<details><summary>A</summary>\n\n# In\n\n</details>\n\n| a |\n| --- |\n| between |\n\n<details><summary>B</summary>Body</details>",
      [typed("details"), typed("table"), typed("details")],
    ],
    [
      '<tg-math-block>\\int_0^1 x^2 dx</tg-math-block>\n\n<tg-map lat="48.8584" long="2.2945" zoom="15"/>\n\n<hr/>\n\n<aside>Pull quote<cite>Source</cite></aside>\n\n<a name="top"></a>',
      [
        typed("mathematical_expression"),
        typed("map", { location: { latitude: 48.8584, longitude: 2.2945 }, zoom: 15 }),
        typed("divider"),
        typed("pullquote"),
        typed("anchor"),
      ],
    ],
    [
      "| Header |\n| --- |\n| <sup>**x**</sup> |\n\n<custom>after</custom>",
      contains({
        0: typed("table", {
          cells: [
            [contains({ text: "Header" })],
            [contains({ text: { type: "superscript", text: { type: "bold", text: "x" } } })],
          ],
        }),
      }),
    ],
    [
      '<tg-collage><img src="https://example.com/1.png"/><figcaption>Album<cite>me</cite></figcaption></tg-collage>\n\n<figure><tg-map lat="1" long="2" zoom="10"/><figcaption>Here</figcaption></figure>',
      [
        typed("collage", { caption: { text: "Album", credit: "me" } }),
        typed("map", { caption: { text: "Here" } }),
      ],
    ],
  ])("preserves HTML block structure: %s", (markdown, expected) => {
    expect(blocksFor(markdown)).toEqual(expected);
  });

  it("reports wide-table degradation inside a disclosure", () => {
    const header = `| ${Array.from({ length: 21 }, (_, index) => `H${index + 1}`).join(" | ")} |`;
    const separator = `| ${Array.from({ length: 21 }, () => "---").join(" | ")} |`;
    const row = `| ${Array.from({ length: 21 }, (_, index) => String(index + 1)).join(" | ")} |`;
    const { blocks, degradationReasons } = markdownToTelegramRichBlocks(
      `<details><summary>Wide</summary>\n\n${header}\n${separator}\n${row}\n\n</details>`,
    );
    expect(degradationReasons).toEqual(["table-ascii"]);
    expect(blocks).toMatchObject([{ type: "details", blocks: [{ type: "pre" }] }]);
    expect(JSON.stringify(blocks)).toContain("H21");
  });

  it("keeps inline code tags inside their authored disclosure", () => {
    const block = single(
      "<details><summary>Code</summary>\n\nKeep `</details>` literal.\n\n</details>",
    );
    expect(block).toMatchObject({ type: "details", blocks: [{ type: "paragraph" }] });
    expect(JSON.stringify(block)).toContain("</details>");
  });

  it("maps <ul> with checkbox tasks", () => {
    const block = single(
      '<ul><li><input type="checkbox" checked/>Done</li><li><input type="checkbox"/>Todo</li><li>Plain</li></ul>',
    );
    assert(block.type === "list");
    expect(block.items).toHaveLength(3);
    expect(block.items[0]).toMatchObject({ has_checkbox: true, is_checked: true });
    expect(block.items[1]).toMatchObject({ has_checkbox: true });
    expect(block.items[1]?.is_checked).toBeUndefined();
    expect(block.items[2]?.has_checkbox).toBeUndefined();
  });

  it.each([
    [
      "ordinary media",
      [image("a.png"), video("a.mp4"), audio("a.mp3")].join("\n\n"),
      ["photo", "video", "audio"],
    ],
    ["GIF animations", [image("a.gif"), video("b.gif")].join("\n\n"), ["animation", "animation"]],
    ["voice notes", [audio("a.opus"), audio("b.ogg")].join("\n\n"), ["voice_note", "voice_note"]],
  ] as const)("maps %s islands", (_name, markdown, types) => {
    expect(blocksFor(markdown).map((block) => block.type)).toEqual(types);
  });

  it("maps Telegram <pre> blocks between rich islands", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      '<hr/>\n<b>Summary</b>\n<pre>Alpha / Beta     10 / 20\nGamma &lt;b&gt;   <i>30</i></pre>\n\n<hr/>\n<pre>\n<code class="language-python">print("ok")\n</code>\n</pre>',
    );
    expect(blocks).toEqual([
      { type: "divider" },
      { type: "paragraph", text: { type: "bold", text: "Summary" } },
      { type: "pre", text: "Alpha / Beta     10 / 20\nGamma <b>   <i>30</i>" },
      { type: "divider" },
      { type: "pre", text: '\nprint("ok")\n\n', language: "python" },
    ]);
    expect(plainText).not.toContain("<pre>");
    expect(plainText).not.toContain("<code");
  });

  it("maps raw HTML tables with caption, header, and spans", () => {
    const block = single(
      "<table><caption>Stats</caption><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td colspan=\" 2 \" rowspan=3 align='center'>wide</td></tr></tbody></table>",
    );
    assert(block.type === "table");
    expect(block.caption).toBe("Stats");
    expect(block.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(block.cells[1]?.[0]).toMatchObject({ colspan: 2, rowspan: 3, align: "center" });
  });

  it.each([
    ["malformed suffix", "2x", "3y"],
    ["unsafe integer", "9007199254740993", "9007199254740993"],
  ])("ignores malformed raw HTML table spans: %s", (_label, colspan, rowspan) => {
    const block = single(
      `<table><tr><td colspan="${colspan}" rowspan="${rowspan}">bad span</td><td>next</td></tr></table>`,
    );
    assert(block.type === "table");
    expect(block.cells[0]?.[0]).toEqual({ text: "bad span", align: "left", valign: "middle" });
    expect(block.cells[0]?.[1]).toEqual({ text: "next", align: "left", valign: "middle" });
  });

  it("keeps unclosed table children literal", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks("<table><tr><td>Unclosed</table>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    expect(plainText).toContain("<tr><td>Unclosed");
  });

  it("keeps prototype-named HTML literal (</constructor>)", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      "a <constructor><sup>**x**</sup></constructor> here",
    );
    expect(plainText).toBe("a <constructor><sup>x</sup></constructor> here");
    expect(blocks).toMatchObject([
      { type: "paragraph", text: expect.arrayContaining([{ type: "bold", text: "x" }]) },
    ]);
  });

  it("keeps unsupported HTML ownership across Markdown tables", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      "<custom>\n\n| Header |\n| --- |\n| <sup>**x**</sup> |\n\n</custom>",
    );
    expect(plainText).toContain("<sup>x</sup>");
    const table = blocks.find((block) => block.type === "table");
    expect(table?.cells[1]?.[0]?.text).toEqual(
      expect.arrayContaining([{ type: "bold", text: "x" }]),
    );
  });

  it("counts rowspan carryover toward the table column limit", () => {
    const secondRow = Array.from({ length: 20 }, (_, i) => `<td>c${i}</td>`).join("");
    const block = single(`<table><tr><td rowspan="2">left</td></tr><tr>${secondRow}</tr></table>`);
    expect(block.type).toBe("pre");
  });

  it("aligns Unicode and expands colspan in over-wide HTML tables", () => {
    const header = [
      '<th colspan="2">Name</th>',
      ...Array.from({ length: 19 }, (_value, index) => `<th>H${index + 3}</th>`),
    ].join("");
    const values = [
      ..."小明,✅,⌚,⚽,👨‍👩‍👧,🇨🇳,1⃣,1️⃣,❤,❤️,©,©️,cafe\u0301".split(","),
      ...Array.from({ length: 8 }, (_value, index) => String(index + 14)),
    ];
    const row = values.map((value) => `<td>${value}</td>`).join("");
    const block = single(`<table><tr>${header}</tr><tr>${row}</tr></table>`);
    assert(block.type === "pre");
    const lines = block.text.split("\n");
    expect(lines.every((line) => line.split("|").length === 23)).toBe(true);
    expect(new Set(lines.map((line) => stringWidth(line))).size).toBe(1);
  });

  it("splits oversized credited blockquotes with the credit on the last piece", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      `<blockquote>${"q".repeat(50)} ${"r".repeat(50)}<cite>Author</cite></blockquote>`,
    );
    const pieces = splitTelegramRichBlocks(blocks, { textLimit: 64 });
    const quotes = pieces.flat().filter((piece) => piece.type === "blockquote");
    expect(quotes.length).toBeGreaterThan(1);
    expect(quotes.filter((quote) => quote.credit !== undefined)).toHaveLength(1);
    expect(quotes.at(-1)?.credit).toBe("Author");
    for (const chunk of pieces) {
      expect(measureInputRichBlocks(chunk).chars).toBeLessThanOrEqual(64);
    }
  });

  it("keeps rowspan tables atomic when splitting", () => {
    const block = single(
      `<table><tr><td rowspan="2">${"a".repeat(40)}</td><td>${"b".repeat(40)}</td></tr><tr><td>${"c".repeat(40)}</td></tr></table>`,
    );
    const pieces = splitTelegramRichBlocks([block], { textLimit: 64 });
    expect(pieces.flat().filter((piece) => piece.type === "table")).toHaveLength(1);
  });

  it.each<[string, string[]]>([
    ['<tg-map lat="48.8north" long="2.3east" zoom="10"/>', []],
    [
      '<figure><img src="https://example.com/a.jpg"/><figcaption>one</figcaption><figcaption>two</figcaption></figure>\n\n<table><caption>x</caption><caption>y</caption><tr><td>a</td></tr></table>',
      ["two", "y"],
    ],
    ["<table><tr>warning<td>x</td></tr></table>", ["warning"]],
    [
      '<tg-collage>warning<img src="https://example.com/a.png"/></tg-collage>\n\n<ul>stray<li>item</li></ul>',
      ["warning", "stray"],
    ],
    [
      '<tg-collage><img src="https://example.com/ok.png"/><img src="http://example.com/bad.png"/></tg-collage>',
      ["bad.png"],
    ],
  ])("keeps rejected HTML and its content literal: %s", (markdown, content) => {
    expectLiteral(markdown, ...content);
  });

  it("projects ordered lists and pullquote credits into plain text", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      "<ol><li>alpha</li><li>beta</li></ol>\n\n<aside>Quote<cite>Author</cite></aside>",
    );
    expect(plainText).toBe("1. alpha\n2. beta\nQuote — Author");
  });
});

it.each<[string, string[], string[]]>([
  [
    'H<sub>2</sub>O E=mc<sup>2</sup> <mark>note</mark> <tg-spoiler>secret</tg-spoiler> <tg-math>E=mc^2</tg-math> <tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>',
    '"subscript" "superscript" "marked" "spoiler" "mathematical_expression" "custom_emoji"'
      .split(" ")
      .concat("5368324170671202286"),
    [],
  ],
  [
    'go <a href="#top">back</a> and [also](#top)',
    ['"anchor_link"', '"anchor_name":"top"'],
    ['"url":"#top"'],
  ],
  ['<tg-emoji emoji-id="not-numeric">😀</tg-emoji> hi', ["😀"], ['"custom_emoji"']],
  ["value is <sup>oops and more text", ["<sup>oops"], ['"superscript"']],
])("preserves inline HTML: %s", (markdown, includes, excludes) => {
  expectJson(blocksFor(markdown), includes, excludes);
});
