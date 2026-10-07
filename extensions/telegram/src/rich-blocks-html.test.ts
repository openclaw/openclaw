import stringWidth from "string-width";
import { assert, describe, expect, it } from "vitest";
import { measureInputRichBlocks, type InputRichBlock } from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

function blocksFor(markdown: string): InputRichBlock[] {
  return markdownToTelegramRichBlocks(markdown).blocks;
}

function single(markdown: string): InputRichBlock {
  const blocks = blocksFor(markdown);
  expect(blocks).toHaveLength(1);
  assert(blocks[0]);
  return blocks[0];
}

function expectLiteral(markdown: string, ...content: string[]) {
  const blocks = blocksFor(markdown);
  expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
  for (const text of content) {
    expect(JSON.stringify(blocks)).toContain(text);
  }
}

describe("block HTML islands", () => {
  it("keeps Markdown lists inside <details> islands", () => {
    const block = single("<details><summary>List</summary>\n\n- item A\n- item B\n\n</details>");
    assert(block.type === "details");
    expect(block.summary).toBe("List");
    expect(block.blocks).toHaveLength(1);
    expect(block.blocks[0]?.type).toBe("paragraph");
    const serialized = JSON.stringify(block);
    expect(serialized).toContain("• item A");
    expect(serialized).toContain("• item B");
    expect(serialized).not.toContain("<details>");
  });

  it.each([true, false])(
    "preserves styled HTML links and entity data (skip detection: %s)",
    (skipEntityDetection) => {
      const { blocks, plainText } = markdownToTelegramRichBlocks(
        '<details><summary>More</summary><div><a href="https://example.com/**path**?q&#61;&quot;hi&quot;">**A &amp; &#38; &amp;amp; \\&amp; A   B\nC&nbsp;D**</a></div></details>',
        { skipEntityDetection },
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
    },
  );

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

  it("ignores tag-shaped code while finding the details summary", () => {
    const block = single("<details><summary><code><summary></code>Title</summary>Body</details>");
    assert(block.type === "details");
    expect(block.summary).toEqual([{ type: "code", text: "<summary>" }, "Title"]);
    expect(block.blocks).toEqual([{ type: "paragraph", text: "Body" }]);
  });

  it("binds summary ranges to their direct details container", () => {
    const block = single(
      "<details><details><summary>Inner</summary>\n\n# Inner heading\n\n</details></details>",
    );
    expect(block).toMatchObject({ type: "details", summary: "Details" });
    assert(block.type === "details");
    expect(block.blocks.map(({ type }) => type)).toEqual(["details"]);
    const inner = block.blocks[0];
    expect(inner).toMatchObject({ type: "details", summary: "Inner" });
    assert(inner?.type === "details");
    expect(inner.blocks.map(({ type }) => type)).toEqual(["heading"]);
  });

  it("keeps same-offset tables before nested <details>", () => {
    const block = single(
      "<details><summary>Outer</summary>\n\n| item | done |\n| --- | --- |\n| table | before |\n\n<details><summary>Inner</summary>\n\n# Inner heading\n\n</details>\n\n</details>",
    );
    assert(block.type === "details");
    expect(block.blocks.map(({ type }) => type)).toEqual(["table", "details"]);
    expect(block.blocks[1]?.type).toBe("details");
  });

  it("keeps a Markdown table between disclosures outside their bodies", () => {
    expect(
      blocksFor(
        "<details><summary>A</summary>\n\n# In\n\n</details>\n\n| a |\n| --- |\n| between |\n\n<details><summary>B</summary>Body</details>",
      ).map((block) => block.type),
    ).toEqual(["details", "table", "details"]);
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

  it.each([
    ["inline", "Keep `</details>` literal.", "paragraph"],
    ["fenced", "```html\n</details>\n<details>\n```", "pre"],
  ])("keeps %s code tags inside their authored disclosure", (_label, body, type) => {
    const block = single(`<details><summary>Code</summary>\n\n${body}\n\n</details>`);
    expect(block).toMatchObject({ type: "details", blocks: [{ type }] });
    expect(JSON.stringify(block)).toContain("</details>");
  });

  it("keeps blockquote wrappers around nested <details>", () => {
    const block = single(
      "<details><summary>Outer</summary>\n\n> <details><summary>Inner</summary>\n>\n> # Inner heading\n>\n> </details>\n\n</details>",
    );
    assert(block.type === "details");
    expect(block.blocks.map(({ type }) => type)).toEqual(["blockquote"]);
    const quote = block.blocks[0];
    assert(quote?.type === "blockquote");
    expect(quote.blocks.map(({ type }) => type)).toEqual(["details"]);
  });

  it("preserves raw blockquote wrappers around nested <details>", () => {
    const block = single(
      "<details><summary>Outer</summary><blockquote><details><summary>Inner</summary>\n\n# Inner heading\n\n</details><cite>Author</cite></blockquote></details>",
    );
    assert(block.type === "details");
    expect(block.blocks.map(({ type }) => type)).toEqual(["blockquote"]);
    const quote = block.blocks[0];
    expect(quote).toMatchObject({ type: "blockquote", credit: "Author" });
    assert(quote?.type === "blockquote");
    expect(quote.blocks.map(({ type }) => type)).toEqual(["details"]);
    const inner = quote.blocks[0];
    expect(inner).toMatchObject({ type: "details", summary: "Inner" });
    assert(inner?.type === "details");
    expect(inner.blocks.map(({ type }) => type)).toEqual(["heading"]);
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

  it("maps figure/img with figcaption and cite credit", () => {
    const block = single(
      '<figure><img src="https://example.com/a.jpg"/><figcaption>Cap<cite>Src</cite></figcaption></figure>',
    );
    expect(block).toEqual({
      type: "photo",
      photo: { type: "photo", media: "https://example.com/a.jpg" },
      caption: { text: "Cap", credit: "Src" },
    });
  });

  it("maps bare img, video, and audio islands", () => {
    const blocks = blocksFor(
      '<img src="https://example.com/a.png"/>\n\n<video src="https://example.com/a.mp4"></video>\n\n<audio src="https://example.com/a.mp3"></audio>',
    );
    expect(blocks.map((block) => block.type)).toEqual(["photo", "video", "audio"]);
  });

  it("maps tg-math-block, tg-map, hr, aside, and anchor islands", () => {
    const blocks = blocksFor(
      '<tg-math-block>\\int_0^1 x^2 dx</tg-math-block>\n\n<tg-map lat="48.8584" long="2.2945" zoom="15"/>\n\n<hr/>\n\n<aside>Pull quote<cite>Source</cite></aside>\n\n<a name="top"></a>',
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "mathematical_expression",
      "map",
      "divider",
      "pullquote",
      "anchor",
    ]);
    expect(blocks[1]).toMatchObject({
      location: { latitude: 48.8584, longitude: 2.2945 },
      zoom: 15,
    });
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

  it("does not use an unclosed summary as a disclosure title", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      "<details><summary>Unclosed</details>",
    );
    expect(blocks).toMatchObject([
      {
        type: "details",
        summary: "Details",
        blocks: [{ type: "paragraph" }],
      },
    ]);
    expect(plainText).toContain("<summary>Unclosed");
  });

  it("keeps unclosed table children literal", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks("<table><tr><td>Unclosed</table>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    expect(plainText).toContain("<tr><td>Unclosed");
  });

  it("keeps unclosed inline tags literal instead of restyling trailing text", () => {
    const blocks = blocksFor("value is <sup>oops and more text");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("<sup>oops");
    expect(serialized).not.toContain('"superscript"');
  });

  it.each(["</constructor>", ""])("keeps prototype-named HTML literal (%s)", (close) => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      `a <constructor><sup>**x**</sup>${close} here`,
    );
    expect(plainText).toBe(`a <constructor><sup>x</sup>${close} here`);
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

  it("keeps HTML active in a table before an unsupported wrapper", () => {
    const blocks = blocksFor("| Header |\n| --- |\n| <sup>**x**</sup> |\n\n<custom>after</custom>");
    expect(blocks[0]).toMatchObject({
      type: "table",
      cells: [
        [{ text: "Header" }],
        [{ text: { type: "superscript", text: { type: "bold", text: "x" } } }],
      ],
    });
  });

  it("counts rowspan carryover toward the table column limit", () => {
    const secondRow = Array.from({ length: 20 }, (_, i) => `<td>c${i}</td>`).join("");
    const block = single(`<table><tr><td rowspan="2">left</td></tr><tr>${secondRow}</tr></table>`);
    expect(block.type).toBe("pre");
  });

  it("rejects http (non-https) media sources", () => {
    expectLiteral('<img src="http://example.com/a.png"/>');
  });

  it("counts and projects table captions and splits them onto the first piece only", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      "<table><caption>Stats</caption><tr><td>a</td></tr><tr><td>b</td></tr></table>",
    );
    expect(plainText).toContain("Stats");
    const table = blocks[0];
    assert(table?.type === "table");
    expect(measureInputRichBlocks([table])).toEqual({ chars: 7, blocks: 3, media: 0, nesting: 1 });
    const pieces = splitTelegramRichBlocks([table], { textLimit: 6 }).flat();
    expect(pieces.length).toBeGreaterThan(1);
    const captioned = pieces.filter((piece) => piece.type === "table" && piece.caption);
    expect(captioned).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ caption: "Stats" });
  });

  it("attaches figcaption captions to collages and figure-wrapped maps", () => {
    const blocks = blocksFor(
      '<tg-collage><img src="https://example.com/1.png"/><figcaption>Album<cite>me</cite></figcaption></tg-collage>\n\n<figure><tg-map lat="1" long="2" zoom="10"/><figcaption>Here</figcaption></figure>',
    );
    expect(blocks[0]).toMatchObject({
      type: "collage",
      caption: { text: "Album", credit: "me" },
    });
    expect(blocks[1]).toMatchObject({ type: "map", caption: { text: "Here" } });
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

  it("emits anchor_link nodes for fragment hrefs", () => {
    const blocks = blocksFor('go <a href="#top">back</a> and [also](#top)');
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"anchor_link"');
    expect(serialized).toContain('"anchor_name":"top"');
    expect(serialized).not.toContain('"url":"#top"');
  });

  it("degrades non-numeric custom emoji ids to alternative text", () => {
    const blocks = blocksFor('<tg-emoji emoji-id="not-numeric">😀</tg-emoji> hi');
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('"custom_emoji"');
    expect(serialized).toContain("😀");
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
      const { chars } = measureInputRichBlocks(chunk);
      expect(chars).toBeLessThanOrEqual(64);
    }
  });

  it("suppresses islands nested under an unmatched supported opener", () => {
    expectLiteral("<details><summary>x</summary><hr/>", "<details>");
  });

  it("maps gif sources to animation blocks", () => {
    const blocks = blocksFor(
      '<img src="https://example.com/a.gif"/>\n\n<video src="https://example.com/b.gif"></video>',
    );
    expect(blocks.map((block) => block.type)).toEqual(["animation", "animation"]);
  });

  it("keeps rowspan tables atomic when splitting", () => {
    const block = single(
      `<table><tr><td rowspan="2">${"a".repeat(40)}</td><td>${"b".repeat(40)}</td></tr><tr><td>${"c".repeat(40)}</td></tr></table>`,
    );
    const pieces = splitTelegramRichBlocks([block], { textLimit: 64 });
    expect(pieces.flat().filter((piece) => piece.type === "table")).toHaveLength(1);
  });

  it("maps ogg and opus audio to voice-note blocks", () => {
    const blocks = blocksFor(
      '<audio src="https://example.com/a.opus"></audio>\n\n<audio src="https://example.com/b.ogg"></audio>',
    );
    expect(blocks.map((block) => block.type)).toEqual(["voice_note", "voice_note"]);
  });

  it("rejects malformed map coordinates instead of accepting numeric prefixes", () => {
    expectLiteral('<tg-map lat="48.8north" long="2.3east" zoom="10"/>');
  });

  it("rejects duplicate captions in figures and tables", () => {
    expectLiteral(
      '<figure><img src="https://example.com/a.jpg"/><figcaption>one</figcaption><figcaption>two</figcaption></figure>\n\n<table><caption>x</caption><caption>y</caption><tr><td>a</td></tr></table>',
      "two",
      "y",
    );
  });

  it.each<[string, string[]]>([
    ['<video src="https://example.com/a.mp4">fallback warning</video>', ["fallback warning"]],
    [
      '<figure><img src="https://example.com/a.jpg"/><img src="https://example.com/b.jpg"/></figure>',
      ["b.jpg"],
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

  it("does not mint blank paragraphs from multiline island indentation", () => {
    const blocks = blocksFor(
      "<details open>\n<summary>Long <b>output</b></summary>\n<p>B</p>\n</details>",
    );
    expect(blocks).toHaveLength(1);
    const details = blocks[0];
    assert(details?.type === "details");
    expect(details.is_open).toBe(true);
    expect(details.summary).toEqual(["Long ", { type: "bold", text: "output" }]);
    expect(details.blocks).toEqual([{ type: "paragraph", text: "B" }]);
  });

  it("projects ordered lists and pullquote credits into plain text", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      "<ol><li>alpha</li><li>beta</li></ol>\n\n<aside>Quote<cite>Author</cite></aside>",
    );
    expect(plainText).toBe("1. alpha\n2. beta\nQuote — Author");
  });
});

describe("inline HTML islands", () => {
  it("maps sup/sub/mark/tg-spoiler/tg-math/tg-emoji inside paragraphs", () => {
    const blocks = blocksFor(
      'H<sub>2</sub>O E=mc<sup>2</sup> <mark>note</mark> <tg-spoiler>secret</tg-spoiler> <tg-math>E=mc^2</tg-math> <tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>',
    );
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('"subscript"');
    expect(serialized).toContain('"superscript"');
    expect(serialized).toContain('"marked"');
    expect(serialized).toContain('"spoiler"');
    expect(serialized).toContain('"mathematical_expression"');
    expect(serialized).toContain('"custom_emoji"');
    expect(serialized).toContain("5368324170671202286");
  });
});
