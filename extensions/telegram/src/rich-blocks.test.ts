// Telegram rich-blocks unit tests for Bot API 10.3 InputRichBlock emission.
import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";
import {
  inputRichBlocksToPlainText,
  measureInputRichBlocks,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

function tableMarkdown(columns: number): string {
  return [
    `| ${Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | ")} |`,
  ].join("\n");
}

function collectLinkTargets(text: RichText, out: string[] = []): string[] {
  if (typeof text === "string") {
    return out;
  }
  if (Array.isArray(text)) {
    for (const part of text) {
      collectLinkTargets(part, out);
    }
    return out;
  }
  if (text.type === "url") {
    out.push(text.url);
  } else if (text.type === "anchor_link") {
    out.push(`#${text.anchor_name}`);
  }
  if ("text" in text) {
    collectLinkTargets(text.text, out);
  }
  return out;
}

function hasStyle(text: RichText, style: string): boolean {
  if (typeof text === "string") {
    return false;
  }
  if (Array.isArray(text)) {
    return text.some((part) => hasStyle(part, style));
  }
  return text.type === style || ("text" in text && hasStyle(text.text, style));
}

describe("markdownToTelegramRichBlocks", () => {
  it("maps task checkboxes from flattened text to native blocks", () => {
    const rendered = markdownToTelegramRichBlocks("- [ ] todo\n- [x] done");
    expect(rendered.blocks).toEqual([
      {
        type: "list",
        items: [
          {
            blocks: [{ type: "paragraph", text: "todo" }],
            has_checkbox: true,
          },
          {
            blocks: [{ type: "paragraph", text: "done" }],
            has_checkbox: true,
            is_checked: true,
          },
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

  it("drops a file:// href but keeps the label instead of leaking raw markdown", () => {
    const rendered = markdownToTelegramRichBlocks(
      "[Nova_Core.md](file:///home/x/workspace/Nova_Core.md)",
    );
    expect(rendered.blocks).toEqual([{ type: "paragraph", text: "Nova_Core.md" }]);
    expect(rendered.plainText).toBe("Nova_Core.md");
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

  it("handles overlapping bold and autolink", () => {
    const { blocks } = markdownToTelegramRichBlocks("**start https://example.com** end");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "bold")).toBe(true);
    expect(collectLinkTargets(text)).toEqual([]);
  });

  it("keeps image alternatives literal and Markdown links in tag-shaped text", () => {
    const result = markdownToTelegramRichBlocks(
      "&lt;b&gt;**literal**&lt;/b&gt; ![<i>alt</i>](https://example.com/image.png) <b[r](https://example.com/qa)>tail",
    );
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        text: [
          "<b>",
          { type: "bold", text: "literal" },
          "</b> <i>alt</i> <b",
          { type: "url", url: "https://example.com/qa", text: "r" },
          ">tail",
        ],
      },
    ]);
    expect(result.plainText).toBe("<b>literal</b> <i>alt</i> <br>tail");
  });

  it("emits tg://user ID links as text mentions (Markdown link)", () => {
    expect(markdownToTelegramRichBlocks("Hi [Sam](tg://user?id=123456789)!").blocks).toEqual([
      {
        type: "paragraph",
        text: [
          "Hi ",
          {
            type: "text_mention",
            text: "Sam",
            user: { id: 123456789, is_bot: false, first_name: "" },
          },
          "!",
        ],
      },
    ]);
  });

  it("emits tg://user ID links inside HTML islands as text mentions", () => {
    expect(
      markdownToTelegramRichBlocks(
        '<details><summary>More</summary><div><a href="tg://user?id=42">Sam</a></div></details>',
      ).blocks,
    ).toEqual([
      {
        type: "details",
        summary: "More",
        blocks: [
          {
            type: "paragraph",
            text: {
              type: "text_mention",
              text: "Sam",
              user: { id: 42, is_bot: false, first_name: "" },
            },
          },
        ],
      },
    ]);
  });

  it("preserves opaque construct syntax provenance", () => {
    expect(markdownToTelegramRichBlocks("<!A &amp; <b>literal</b>>").blocks).toEqual([
      { type: "paragraph", text: "<!A &amp; <b>literal</b>>" },
    ]);
  });

  it("excludes transcript annotations from HTML url wrappers", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks(
      '<a href="https://example.com">\nuser[Thu] trailing</a>',
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        text: expect.arrayContaining([
          { type: "code", text: "user[Thu]" },
          { type: "url", url: "https://example.com", text: " trailing" },
        ]),
      },
    ]);
    expect(plainText).toBe("\nuser[Thu] trailing");
  });

  it("preserves authored https://example.com links with code-only labels", () => {
    for (const [prefix, suffix] of [
      ["", ""],
      ["", "bar"],
      ["a", "z"],
    ]) {
      const markdown = `${prefix ? `\`${prefix}\`` : ""}[\`foo\`](https://example.com)${suffix ? `\`${suffix}\`` : ""}`;
      const { blocks, plainText } = markdownToTelegramRichBlocks(markdown);
      const text = blocks[0]?.type === "paragraph" ? blocks[0].text : "";
      expect(collectLinkTargets(text), markdown).toEqual(["https://example.com"]);
      expect(hasStyle(text, "code"), markdown).toBe(true);
      expect(plainText).toBe(`${prefix}foo${suffix}`);
    }
  });

  it("preserves independently authored bold inside merged adjacent code spans", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks("`a`**`b`**`c`");
    const text = blocks[0]?.type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "code")).toBe(true);
    expect(hasStyle(text, "bold")).toBe(true);
    expect(plainText).toBe("abc");
  });

  it("preserves crossing inline ranges in [A ||B](https://example.com) C|| D", () => {
    const result = markdownToTelegramRichBlocks("[A ||B](https://example.com) C|| D");
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        text: [
          {
            type: "url",
            url: "https://example.com",
            text: ["A ", { type: "spoiler", text: "B" }],
          },
          { type: "spoiler", text: " C" },
          " D",
        ],
      },
    ]);
    expect(result.plainText).toBe("A B C D");
  });

  it("renders tables with header row, aligns, borders, and stripes", () => {
    const { blocks, degradationReasons } = markdownToTelegramRichBlocks(
      "| Feature | Status | Count |\n| :--- | :---: | ---: |\n| Rich | Fixed | 2 |",
      { tableMode: "block" },
    );
    expect(degradationReasons).toEqual([]);
    const table = blocks.find((block) => block.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.is_bordered).toBe(true);
    expect(table.is_striped).toBe(true);
    expect(table.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(table.cells[0]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
    expect(table.cells[1]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
  });

  it("uses code tables when tableMode is code", () => {
    const { blocks } = markdownToTelegramRichBlocks(tableMarkdown(2), { tableMode: "code" });
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
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual([]);
  });

  it("preserves authored file-style links while wrapping bare file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks("README.md [README.md](https://README.md)");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual(["https://README.md"]);
    expect(hasStyle(text, "code")).toBe(true);
  });
});

describe("splitTelegramRichBlocks", () => {
  it("does not split surrogate pairs at oversized-block boundaries", () => {
    const text = `${"a".repeat(63)}😀tail`;
    const chunks = splitTelegramRichBlocks([{ type: "pre", text }], { textLimit: 64 });
    for (const piece of chunks.flat()) {
      if (piece.type === "pre") {
        expect(piece.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      }
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
    const quote: InputRichBlock = {
      type: "blockquote",
      blocks: [
        { type: "paragraph", text: "q".repeat(50) },
        { type: "paragraph", text: "r".repeat(50) },
      ],
    };
    const table: InputRichBlock = {
      type: "table",
      cells: [
        [{ text: "h".repeat(40), is_header: true, align: "left", valign: "middle" }],
        [{ text: "c".repeat(40), align: "left", valign: "middle" }],
        [{ text: "d".repeat(40), align: "left", valign: "middle" }],
      ],
    };
    const chunks = splitTelegramRichBlocks([quote, table], { textLimit: 64 });
    for (const chunk of chunks) {
      const { chars } = measureInputRichBlocks(chunk);
      expect(chars).toBeLessThanOrEqual(64);
    }
  });

  it("enforces recursive block limits for details children", () => {
    const children: InputRichBlock[] = Array.from({ length: 6 }, (_, index) => ({
      type: "paragraph",
      text: `entry ${index}`,
    }));
    const block: InputRichBlock = { type: "details", blocks: children, summary: "Summary" };

    const chunks = splitTelegramRichBlocks([block], { blockLimit: 5 });

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => measureInputRichBlocks(chunk).blocks <= 5)).toBe(true);
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
      cells: Array.from({ length: 6 }, (_, index) => [
        [{ text: `row ${index}`, align: "left" as const, valign: "middle" as const }],
      ]).flat(),
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

    expect(tableChunks.every((chunk) => measureInputRichBlocks(chunk).blocks <= 5)).toBe(true);
    expect(tables.flatMap((part) => part.cells)).toEqual(table.cells);
    expect(tables.flatMap((part) => (part.caption ? [part.caption] : []))).toEqual([
      "Table caption",
    ]);
    expect(mediaChunks.every((chunk) => measureInputRichBlocks(chunk).media <= 50)).toBe(true);
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
    const pages = planTelegramTextDeliveryPages({ text, maxChars: 32_768, richMessages: true });
    const delivered = pages.map((page) => page.plainText).join("");
    expect(delivered).toContain("https://example.com/a.jpg");
    expect(delivered).toContain("https://example.com/a.mp4");
    expect(delivered).toContain("https://example.com/a.mp3");
  });

  it("delivers deeply nested details with readable text beyond the rich depth budget", () => {
    const depth = 5000;
    const text =
      "<details><summary>s</summary>".repeat(depth) + "leaf" + "</details>".repeat(depth);
    const pages = planTelegramTextDeliveryPages({ text, maxChars: 32_768, richMessages: true });
    expect(
      pages
        .map((page) => page.plainText)
        .join("")
        .replace(/\s/g, ""),
    ).toBe("s".repeat(depth) + "leaf");
    expect(pages[0]?.richMessage?.blocks[0]?.type).toBe("details");
    for (const page of pages) {
      expect(measureInputRichBlocks(page.richMessage?.blocks ?? []).nesting).toBeLessThanOrEqual(
        15,
      );
    }
  });

  it("bounds caller-supplied blocks and inline arrays before planning delivery", () => {
    let text: RichText = "leaf";
    let block: InputRichBlock = { type: "paragraph", text: "body" };
    for (let depth = 0; depth < 5000; depth += 1) {
      text = [{ type: "bold", text }];
      block = { type: "details", summary: "s", blocks: [block] };
    }
    const pages = planTelegramTextDeliveryPages({
      text: "",
      maxChars: 32_768,
      richMessages: true,
      richMessage: { blocks: [{ type: "paragraph", text }, block] },
    });
    expect(
      pages
        .map((page) => page.plainText)
        .join("")
        .replace(/\s/g, ""),
    ).toBe("leaf" + "s".repeat(5000) + "body");
    for (const page of pages) {
      expect(measureInputRichBlocks(page.richMessage?.blocks ?? []).nesting).toBeLessThanOrEqual(
        15,
      );
    }
  });

  it("preserves ordinary ordered lists across recursive block chunks", () => {
    const text = Array.from({ length: 250 }, (_, index) => `${index + 1}. item ${index + 1}`).join(
      "\n",
    );

    const chunks = planTelegramTextDeliveryPages({ text, maxChars: 32_768, richMessages: true });
    const lists = chunks
      .flatMap((chunk) => chunk.richMessage?.blocks ?? [])
      .filter((block) => block.type === "list");

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) => measureInputRichBlocks(chunk.richMessage?.blocks ?? []).blocks <= 500,
      ),
    ).toBe(true);
    expect(lists.flatMap((list) => list.items).map((item) => item.value)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    expect(chunks.flatMap((chunk) => chunk.degradationReasons ?? [])).toEqual([]);
  });

  it("applies the document-level skip flag to every chunk", () => {
    // An email anywhere disables linkification for the whole render, so chunks
    // without the email would otherwise expose unprotected file refs (README.md)
    // to Telegram's server-side entity detection.
    const chunks = planTelegramTextDeliveryPages({
      text: `see README.md for details\n\n${"filler ".repeat(20)}\n\nping owner@example.com`,
      maxChars: 80,
      richMessages: true,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.richMessage?.skip_entity_detection === true)).toBe(true);
  });

  it("sends readable source text when markdown projects to zero blocks", () => {
    const chunks = planTelegramTextDeliveryPages({
      text: "[ref]: https://example.com",
      maxChars: 32_768,
      richMessages: true,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.plainText).toContain("example.com");
  });
});
