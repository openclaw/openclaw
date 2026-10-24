import { assert, describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";
import {
  inputRichBlocksToPlainText,
  measureInputRichBlocks,
  type InputRichBlock,
  type RichText,
  type RichBlockTableCell,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

const paragraph = (text: RichText): InputRichBlock => ({ type: "paragraph", text });
const mention = (id: number): RichText => ({
  type: "text_mention",
  text: "Sam",
  user: { id, is_bot: false, first_name: "" },
});
const firstText = (blocks: InputRichBlock[]): RichText =>
  blocks[0]?.type === "paragraph" ? blocks[0].text : "";
const pagesFor = (text: string, maxChars = 32_768) =>
  planTelegramTextDeliveryPages({ text, maxChars, richMessages: true });
const pageBlocks = (pages: ReturnType<typeof pagesFor>) =>
  pages.map((page) => page.richMessage?.blocks ?? []);
const pageText = (pages: ReturnType<typeof pagesFor>) =>
  pages
    .map((page) => page.plainText)
    .join("")
    .replace(/\s/g, "");
const makeCell = (text: string): RichBlockTableCell => ({
  text,
  align: "left",
  valign: "middle",
});
type Metric = keyof ReturnType<typeof measureInputRichBlocks>;
function expectBudget(chunks: InputRichBlock[][], metric: Metric, limit: number) {
  for (const chunk of chunks) {
    expect(measureInputRichBlocks(chunk)[metric]).toBeLessThanOrEqual(limit);
  }
}

function* textNodes(text: RichText): Generator<Exclude<RichText, string | RichText[]>> {
  if (typeof text === "string") {
    return;
  }
  if (Array.isArray(text)) {
    for (const part of text) {
      yield* textNodes(part);
    }
  } else {
    yield text;
    if ("text" in text) {
      yield* textNodes(text.text);
    }
  }
}
function collectLinkTargets(text: RichText): string[] {
  return [...textNodes(text)].flatMap((node) =>
    node.type === "url" ? [node.url] : node.type === "anchor_link" ? [`#${node.anchor_name}`] : [],
  );
}
const hasStyle = (text: RichText, style: string) =>
  [...textNodes(text)].some((node) => node.type === style);

describe("markdownToTelegramRichBlocks", () => {
  it("maps task checkboxes from flattened text to native blocks", () => {
    const rendered = markdownToTelegramRichBlocks("- [ ] todo\n- [x] done");
    expect(rendered.blocks).toEqual([
      {
        type: "list",
        items: [
          { blocks: [paragraph("todo")], has_checkbox: true },
          { blocks: [paragraph("done")], has_checkbox: true, is_checked: true },
        ],
      },
    ]);
    expect(rendered.plainText).toBe("• [ ] todo\n• [x] done");
  });

  it("keeps the classic sendMessage list path byte-identical", () => {
    expect(markdownToTelegramHtml("- [ ] todo\n- [x] done\n\n4. fourth\n5. fifth")).toBe(
      "• [ ] todo\n• [x] done\n\n4. fourth\n5. fifth",
    );
  });

  it("includes surrounding blockquotes in the 16-level nesting budget", () => {
    const markdown = Array.from(
      { length: 16 },
      (_, index) => `> ${"  ".repeat(index)}- level ${index + 1}`,
    ).join("\n");
    const rendered = markdownToTelegramRichBlocks(markdown);
    expect(rendered.degradationReasons).toEqual(["list-limit"]);
    expect(JSON.stringify(rendered.blocks)).not.toContain('"type":"list"');
  });

  it.each([
    ["**start https://example.com** end", ["bold"], []],
    ["`a`**`b`**`c`", ["code", "bold"], []],
    ["README.md [README.md](https://README.md)", ["code"], ["https://README.md"]],
  ] as const)("preserves authored style and link boundaries: %s", (source, styles, urls) => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(source);
    const text = firstText(blocks);
    for (const style of styles) {
      expect(hasStyle(text, style)).toBe(true);
    }
    expect(collectLinkTargets(text)).toEqual(urls);
    if (source === "`a`**`b`**`c`") {
      expect(plainText).toBe("abc");
    }
  });

  it.each([
    ["Ruteoversikten: https://example.vercel.app/spa/", true, ["https://example.vercel.app/spa/"]],
    ["see https://example.com/flow?a=1&b=2", true, []],
    ["https://example.com/spa", false, []],
    ["note: README.md", true, []],
  ] as const)(
    "preserves bare links with detection policy (#171111): %s",
    (source, skipEntityDetection, urls) => {
      const { blocks, plainText } = markdownToTelegramRichBlocks(source, { skipEntityDetection });
      expect(collectLinkTargets(firstText(blocks))).toEqual(urls);
      expect(plainText).toBe(source);
      expect(hasStyle(firstText(blocks), "code")).toBe(false);
    },
  );

  it.each<[string, RichText, string]>([
    ["[Nova_Core.md](file:///home/x/workspace/Nova_Core.md)", "Nova_Core.md", "Nova_Core.md"],
    [
      "&lt;b&gt;**literal**&lt;/b&gt; ![<i>alt</i>](https://example.com/image.png) <b[r](https://example.com/qa)>tail",
      [
        "<b>",
        { type: "bold", text: "literal" },
        "</b> <i>alt</i> <b",
        { type: "url", url: "https://example.com/qa", text: "r" },
        ">tail",
      ],
      "<b>literal</b> <i>alt</i> <br>tail",
    ],
    ["Hi [Sam](tg://user?id=123456789)!", ["Hi ", mention(123456789), "!"], "Hi Sam!"],
    ["<!A &amp; <b>literal</b>>", "<!A &amp; <b>literal</b>>", "<!A &amp; <b>literal</b>>"],
    [
      '<a href="https://example.com">\nuser[Thu] trailing</a>',
      expect.arrayContaining([
        { type: "code", text: "user[Thu]" },
        { type: "url", url: "https://example.com", text: " trailing" },
      ]),
      "\nuser[Thu] trailing",
    ],
    [
      "[A ||B](https://example.com) C|| D",
      [
        { type: "url", url: "https://example.com", text: ["A ", { type: "spoiler", text: "B" }] },
        { type: "spoiler", text: " C" },
        " D",
      ],
      "A B C D",
    ],
  ])("preserves paragraph structure and text: %s", (source, text, plainText) => {
    const result = markdownToTelegramRichBlocks(source);
    expect(result.blocks).toEqual([paragraph(text)]);
    expect(result.plainText).toBe(plainText);
  });

  it("emits tg://user ID links inside HTML islands as text mentions", () => {
    expect(
      markdownToTelegramRichBlocks(
        '<details><summary>More</summary><div><a href="tg://user?id=42">Sam</a></div></details>',
      ).blocks,
    ).toEqual([{ type: "details", summary: "More", blocks: [paragraph(mention(42))] }]);
  });

  it("preserves authored https://example.com links with code-only labels", () => {
    for (const [prefix, suffix] of [
      ["", ""],
      ["", "bar"],
      ["a", "z"],
    ]) {
      const markdown = `${prefix ? `\`${prefix}\`` : ""}[\`foo\`](https://example.com)${suffix ? `\`${suffix}\`` : ""}`;
      const { blocks, plainText } = markdownToTelegramRichBlocks(markdown);
      const text = firstText(blocks);
      expect(collectLinkTargets(text), markdown).toEqual(["https://example.com"]);
      expect(hasStyle(text, "code"), markdown).toBe(true);
      expect(plainText).toBe(`${prefix}foo${suffix}`);
    }
  });

  it("renders tables with header row, aligns, borders, and stripes", () => {
    const { blocks, degradationReasons } = markdownToTelegramRichBlocks(
      "| Feature | Status | Count |\n| :--- | :---: | ---: |\n| Rich | Fixed | 2 |",
      { tableMode: "block" },
    );
    expect(degradationReasons).toEqual([]);
    const table = blocks.find((block) => block.type === "table");
    assert(table?.type === "table");
    expect(table).toMatchObject({ is_bordered: true, is_striped: true });
    expect(table.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(table.cells[0]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
    expect(table.cells[1]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
  });

  it("uses code tables when tableMode is code", () => {
    const { blocks } = markdownToTelegramRichBlocks("| H1 | H2 |\n| --- | --- |\n| 1 | 2 |", {
      tableMode: "code",
    });
    expect(blocks.some((block) => block.type === "pre")).toBe(true);
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });

  it("keeps unsupported local links as visible text and wraps file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "[scripts/yougile.py](/home/user/scripts/yougile.py#L41) and [config](./openclaw.json)",
    );
    const plain = inputRichBlocksToPlainText(blocks);
    expect(plain).toContain("scripts/yougile.py");
    expect(plain).toContain("config");
    expect(collectLinkTargets(firstText(blocks))).toEqual([]);
  });
});

describe("splitTelegramRichBlocks", () => {
  it("does not split surrogate pairs at oversized-block boundaries", () => {
    const text = `${"a".repeat(63)}😀tail`;
    const chunks = splitTelegramRichBlocks([{ type: "pre", text }], { textLimit: 64 });
    for (const piece of chunks.flat().filter((block) => block.type === "pre")) {
      expect(piece.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    }
  });

  it("keeps link targets when an oversized styled paragraph splits", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      `${"x".repeat(60)} [docs](https://example.com/${"y".repeat(40)}) tail`,
    );
    const chunks = splitTelegramRichBlocks(blocks, { textLimit: 64 });
    const urls = chunks
      .flat()
      .flatMap((block) => (block.type === "paragraph" ? collectLinkTargets(block.text) : []));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("https://example.com/"))).toBe(true);
  });

  it("splits oversized blockquotes and tables at inner boundaries", () => {
    const chunks = splitTelegramRichBlocks(
      [
        { type: "blockquote", blocks: [paragraph("q".repeat(50)), paragraph("r".repeat(50))] },
        {
          type: "table",
          cells: [
            [{ ...makeCell("h".repeat(40)), is_header: true }],
            [makeCell("c".repeat(40))],
            [makeCell("d".repeat(40))],
          ],
        },
      ],
      { textLimit: 64 },
    );
    expectBudget(chunks, "chars", 64);
  });

  it("enforces recursive block limits for details children", () => {
    const children = Array.from({ length: 6 }, (_, index) => paragraph(`entry ${index}`));
    const block: InputRichBlock = { type: "details", blocks: children, summary: "Summary" };

    const chunks = splitTelegramRichBlocks([block], { blockLimit: 5 });

    expect(chunks).toHaveLength(2);
    expectBudget(chunks, "blocks", 5);
    expect(
      chunks
        .flat()
        .flatMap((part) =>
          part.type === "blockquote" || part.type === "details" ? part.blocks : [],
        ),
    ).toEqual(children);
  });

  it("splits table rows and album media without duplicating captions", () => {
    const table: InputRichBlock = {
      type: "table",
      caption: "Table caption",
      cells: Array.from({ length: 6 }, (_, index) => [makeCell(`row ${index}`)]),
    };
    const collage: InputRichBlock = {
      type: "collage",
      caption: { text: "Album caption" },
      blocks: Array.from({ length: 51 }, (_, index) => ({
        type: "photo" as const,
        photo: { type: "photo" as const, media: `https://example.com/${index}.jpg` },
      })),
    };

    const tableChunks = splitTelegramRichBlocks([table], { blockLimit: 5 });
    const mediaChunks = splitTelegramRichBlocks([collage]);
    const tables = tableChunks.flat().filter((block) => block.type === "table");
    const albums = mediaChunks.flat().filter((block) => block.type === "collage");

    expectBudget(tableChunks, "blocks", 5);
    expect(tables.flatMap((part) => part.cells)).toEqual(table.cells);
    expect(tables.flatMap((part) => (part.caption ? [part.caption] : []))).toEqual([
      "Table caption",
    ]);
    expectBudget(mediaChunks, "media", 50);
    expect(albums.flatMap((album) => album.blocks)).toEqual(collage.blocks);
    expect(albums.flatMap((album) => (album.caption ? [album.caption.text] : []))).toEqual([
      "Album caption",
    ]);
  });
});

describe("rich message plan wiring", () => {
  it("preserves media sources beyond HTML depth 61", () => {
    const text =
      "<details><summary>s</summary>".repeat(61) +
      '<img src="https://example.com/a.jpg"/>' +
      '<video src="https://example.com/a.mp4"></video>' +
      '<audio src="https://example.com/a.mp3"></audio>' +
      "</details>".repeat(61);
    const pages = pagesFor(text);
    const delivered = pages.map((page) => page.plainText).join("");
    expect(delivered).toContain("https://example.com/a.jpg");
    expect(delivered).toContain("https://example.com/a.mp4");
    expect(delivered).toContain("https://example.com/a.mp3");
  });

  it("delivers deeply nested details with readable text beyond the rich depth budget", () => {
    const depth = 5000;
    const text =
      "<details><summary>s</summary>".repeat(depth) + "leaf" + "</details>".repeat(depth);
    const pages = pagesFor(text);
    expect(pageText(pages)).toBe("s".repeat(depth) + "leaf");
    expect(pages[0]?.richMessage?.blocks[0]?.type).toBe("details");
    expectBudget(pageBlocks(pages), "nesting", 15);
  });

  it("bounds caller-supplied blocks and inline arrays before planning delivery", () => {
    let text: RichText = "leaf";
    let block: InputRichBlock = paragraph("body");
    for (let depth = 0; depth < 5000; depth += 1) {
      text = [{ type: "bold", text }];
      block = { type: "details", summary: "s", blocks: [block] };
    }
    const pages = planTelegramTextDeliveryPages({
      text: "",
      maxChars: 32_768,
      richMessages: true,
      richMessage: { blocks: [paragraph(text), block] },
    });
    expect(pageText(pages)).toBe("leaf" + "s".repeat(5000) + "body");
    expectBudget(pageBlocks(pages), "nesting", 15);
  });

  it("preserves ordinary ordered lists across recursive block chunks", () => {
    const text = Array.from({ length: 250 }, (_, index) => `${index + 1}. item ${index + 1}`).join(
      "\n",
    );

    const chunks = pagesFor(text);
    const lists = chunks
      .flatMap((chunk) => chunk.richMessage?.blocks ?? [])
      .filter((block) => block.type === "list");

    expect(chunks.length).toBeGreaterThan(1);
    expectBudget(pageBlocks(chunks), "blocks", 500);
    expect(lists.flatMap((list) => list.items).map((item) => item.value)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    expect(chunks.flatMap((chunk) => chunk.degradationReasons ?? [])).toEqual([]);
  });

  it("applies the document-level skip flag to every chunk", () => {
    // The later email disables detection document-wide, protecting README.md in earlier chunks.
    const chunks = pagesFor(
      `see README.md for details\n\n${"filler ".repeat(20)}\n\nping owner@example.com`,
      80,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.richMessage?.skip_entity_detection === true)).toBe(true);
  });

  it("sends readable source text when markdown projects to zero blocks", () => {
    const chunks = pagesFor("[ref]: https://example.com");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.plainText).toContain("example.com");
  });

  it("keeps raw-block entity detection page-local and reports degradation once", () => {
    const pages = planTelegramTextDeliveryPages({
      text: "source text is not the rich-block projection",
      maxChars: 20,
      richMessages: true,
      richMessage: {
        blocks: [paragraph("README.md"), paragraph("owner@example.com")],
      },
      degradationReasons: ["list-limit"],
    });
    expect(pages.map((page) => page.plainText)).toEqual(["README.md", "owner@example.com"]);
    expect(pages.map((page) => page.richMessage?.skip_entity_detection)).toEqual([undefined, true]);
    expect(pages.map((page) => page.degradationReasons)).toEqual([["list-limit"], undefined]);
  });
});
