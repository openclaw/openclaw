// Telegram Bot API 10.2 budgets nested blocks and attachments, not top-level wrappers.
import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import {
  countInputRichBlockChars,
  countInputRichBlockMedia,
  countInputRichBlocks,
  type InputRichBlock,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { getTelegramRichRawApi, splitTelegramRichMessageTextChunks } from "./rich-message.js";

describe("Telegram rich block budgets", () => {
  it("counts nested containers against Telegram's actual block budget", () => {
    const blocks: InputRichBlock[] = Array.from({ length: 3 }, (_, index) => ({
      type: "blockquote",
      blocks: [{ type: "paragraph", text: `quote ${index}` }],
    }));

    const chunks = splitTelegramRichBlocks(blocks, { blockLimit: 4 });

    expect(chunks.map((chunk) => countInputRichBlocks(chunk))).toEqual([4, 2]);
  });

  it("splits native lists by nested item and block budget without changing ordered values", () => {
    const list: InputRichBlock = {
      type: "list",
      items: Array.from({ length: 5 }, (_, index) => ({
        blocks: [{ type: "paragraph", text: `item ${index}` }],
        value: index + 1,
      })),
    };

    const chunks = splitTelegramRichBlocks([list], { blockLimit: 5 });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => countInputRichBlocks(chunk) <= 5)).toBe(true);
    expect(chunks.flat().flatMap((block) => (block.type === "list" ? block.items : []))).toEqual(
      list.type === "list" ? list.items : [],
    );
  });

  it("preserves empty ordered-list items while splitting neighboring populated items", () => {
    const items = [
      { blocks: [], value: 1 },
      { blocks: [{ type: "paragraph" as const, text: "second" }], value: 2 },
      { blocks: [{ type: "paragraph" as const, text: "third" }], value: 3 },
      { blocks: [], value: 4 },
    ];

    const chunks = splitTelegramRichBlocks([{ type: "list", items }], { blockLimit: 5 });

    expect(chunks.every((chunk) => countInputRichBlocks(chunk) <= 5)).toBe(true);
    expect(chunks.flat().flatMap((block) => (block.type === "list" ? block.items : []))).toEqual(
      items,
    );
  });

  it("keeps indivisible ordered and checklist items atomic instead of duplicating metadata", () => {
    for (const metadata of [
      { value: 7 },
      { has_checkbox: true as const, is_checked: true as const },
    ]) {
      const list: InputRichBlock = {
        type: "list",
        items: [
          {
            ...metadata,
            blocks: Array.from({ length: 3 }, (_, index) => ({
              type: "paragraph",
              text: `part ${index}`,
            })),
          },
        ],
      };

      expect(splitTelegramRichBlocks([list], { blockLimit: 4 })).toEqual([[list]]);
    }
  });

  it("keeps an indivisible list item with oversized text atomic for plain fallback", () => {
    const list: InputRichBlock = {
      type: "list",
      items: [{ value: 3, blocks: [{ type: "paragraph", text: "oversized item" }] }],
    };

    expect(splitTelegramRichBlocks([list], { textLimit: 5 })).toEqual([[list]]);
  });

  it("splits lists between whole items at the 50-media limit", () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      value: index + 1,
      blocks: [
        {
          type: "photo" as const,
          photo: { type: "photo" as const, media: `https://example.com/${index}.jpg` },
        },
      ],
    }));

    const chunks = splitTelegramRichBlocks([{ type: "list", items }]);

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) => chunk.reduce((total, block) => total + countInputRichBlockMedia(block), 0) <= 50,
      ),
    ).toBe(true);
    expect(chunks.flat().flatMap((block) => (block.type === "list" ? block.items : []))).toEqual(
      items,
    );
  });

  it("keeps an indivisible media-heavy list item atomic for plain fallback", () => {
    const list: InputRichBlock = {
      type: "list",
      items: [
        {
          value: 5,
          blocks: Array.from({ length: 51 }, (_, index) => ({
            type: "photo",
            photo: { type: "photo", media: `https://example.com/${index}.jpg` },
          })),
        },
      ],
    };

    expect(splitTelegramRichBlocks([list])).toEqual([[list]]);
  });

  it("splits tables by nested row budget and preserves the original caption once", () => {
    const table: InputRichBlock = {
      type: "table",
      caption: "Table caption",
      cells: Array.from({ length: 6 }, (_, index) => [{ text: `row ${index}` }]),
    };

    const chunks = splitTelegramRichBlocks([table], { blockLimit: 5 });
    const tables = chunks.flat().filter((block) => block.type === "table");

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => countInputRichBlocks(chunk) <= 5)).toBe(true);
    expect(tables.flatMap((block) => block.cells)).toEqual(
      table.type === "table" ? table.cells : [],
    );
    expect(tables.map((block) => block.caption)).toEqual(["Table caption", undefined]);
  });

  it("keeps spanning tables atomic when a nested row limit cannot preserve their spans", () => {
    const table: InputRichBlock = {
      type: "table",
      cells: [
        [{ text: "shared", rowspan: 6 }],
        ...Array.from({ length: 5 }, (_, index) => [{ text: `row ${index}` }]),
      ],
    };

    expect(splitTelegramRichBlocks([table], { blockLimit: 5 })).toEqual([[table]]);
  });

  it("splits nested quotes and details without exceeding their wrapper budget", () => {
    for (const type of ["blockquote", "details"] as const) {
      const blocks: InputRichBlock[] = [
        type === "blockquote"
          ? {
              type,
              credit: "Author",
              blocks: Array.from({ length: 6 }, (_, index) => ({
                type: "paragraph" as const,
                text: `entry ${index}`,
              })),
            }
          : {
              type,
              summary: "Summary",
              is_open: true,
              blocks: Array.from({ length: 6 }, (_, index) => ({
                type: "paragraph" as const,
                text: `entry ${index}`,
              })),
            },
      ];

      const chunks = splitTelegramRichBlocks(blocks, { blockLimit: 5 });

      expect(chunks, type).toHaveLength(2);
      expect(
        chunks.every((chunk) => countInputRichBlocks(chunk) <= 5),
        type,
      ).toBe(true);
      expect(
        chunks.flat().every((block) => block.type === type),
        type,
      ).toBe(true);
    }
  });

  it("preserves irreducibly oversized wrapper text for the existing plain fallback", () => {
    const blocks: InputRichBlock[] = [
      { type: "details", summary: "oversized summary", blocks: [] },
      {
        type: "blockquote",
        credit: "oversized credit",
        blocks: [{ type: "paragraph", text: "body" }],
      },
      { type: "details", summary: "exact", blocks: [{ type: "paragraph", text: "body" }] },
      {
        type: "collage",
        caption: { text: "oversized caption" },
        blocks: [{ type: "photo", photo: { type: "photo", media: "https://example.com/1.jpg" } }],
      },
    ];

    for (const block of blocks) {
      expect(splitTelegramRichBlocks([block], { textLimit: 5 })).toEqual([[block]]);
    }
  });

  it("splits collage attachments at Telegram's 50-media limit without duplicating captions", () => {
    const collage: InputRichBlock = {
      type: "collage",
      caption: { text: "Album" },
      blocks: Array.from({ length: 51 }, (_, index) => ({
        type: "photo",
        photo: { type: "photo", media: `https://example.com/${index}.jpg` },
      })),
    };

    const chunks = splitTelegramRichBlocks([collage]);
    const albums = chunks.flat().filter((block) => block.type === "collage");

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) => chunk.reduce((total, block) => total + countInputRichBlockMedia(block), 0) <= 50,
      ),
    ).toBe(true);
    expect(albums.flatMap((block) => block.blocks)).toEqual(
      collage.type === "collage" ? collage.blocks : [],
    );
    expect(albums.flatMap((block) => (block.caption ? [block.caption.text] : []))).toEqual([
      "Album",
    ]);
  });

  it("splits zero-text album media when its caption exactly fills the text budget", () => {
    const collage: InputRichBlock = {
      type: "collage",
      caption: { text: "Album" },
      blocks: Array.from({ length: 51 }, (_, index) => ({
        type: "photo",
        photo: { type: "photo", media: `https://example.com/${index}.jpg` },
      })),
    };

    const chunks = splitTelegramRichBlocks([collage], { textLimit: 5 });
    const albums = chunks.flat().filter((block) => block.type === "collage");

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) => chunk.reduce((total, block) => total + countInputRichBlockChars(block), 0) <= 5,
      ),
    ).toBe(true);
    expect(
      chunks.every(
        (chunk) => chunk.reduce((total, block) => total + countInputRichBlockMedia(block), 0) <= 50,
      ),
    ).toBe(true);
    expect(albums.flatMap((block) => (block.caption ? [block.caption.text] : []))).toEqual([
      "Album",
    ]);
    expect(albums.flatMap((block) => block.blocks)).toHaveLength(51);
  });

  it("keeps native HTML list and table wire payloads within the 500-block limit", () => {
    const list = `<ol>${Array.from({ length: 250 }, (_, index) => `<li>item ${index + 1}</li>`).join("")}</ol>`;
    const table = `<table>${Array.from({ length: 500 }, (_, index) => `<tr><td>row ${index + 1}</td></tr>`).join("")}</table>`;

    const chunks = splitTelegramRichMessageTextChunks({
      text: `${list}\n\n${table}`,
      textLimit: 32_768,
    });
    const blocks = chunks.flatMap((chunk) => chunk.richMessage.blocks);
    const lists = blocks.filter((block) => block.type === "list");
    const tables = blocks.filter((block) => block.type === "table");

    expect(chunks.every((chunk) => countInputRichBlocks(chunk.richMessage.blocks) <= 500)).toBe(
      true,
    );
    expect(lists.flatMap((block) => block.items)).toHaveLength(250);
    expect(lists.flatMap((block) => block.items.map((item) => item.value))).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    expect(tables.flatMap((block) => block.cells)).toHaveLength(500);
  });

  it("keeps native HTML collage payloads within the 50-attachment limit", () => {
    const photos = Array.from(
      { length: 51 },
      (_, index) => `<img src="https://example.com/${index}.jpg"/>`,
    ).join("");

    const chunks = splitTelegramRichMessageTextChunks({
      text: `<tg-collage>${photos}<figcaption>Album</figcaption></tg-collage>`,
      textLimit: 32_768,
    });
    const albums = chunks
      .flatMap((chunk) => chunk.richMessage.blocks)
      .filter((block) => block.type === "collage");

    expect(chunks).toHaveLength(2);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.blocks.reduce(
            (total, block) => total + countInputRichBlockMedia(block),
            0,
          ) <= 50,
      ),
    ).toBe(true);
    expect(albums.flatMap((block) => (block.caption ? [block.caption.text] : []))).toEqual([
      "Album",
    ]);
  });

  it("sends only valid nested payloads through the real grammY raw Bot API client", async () => {
    const requests: Array<{ rich_message: { blocks: InputRichBlock[] } }> = [];
    const bot = new Bot("123456:telegram-rich-wire-proof", {
      client: {
        fetch: async (_input, init) => {
          const body = typeof init?.body === "string" ? init.body : "";
          const request = JSON.parse(body) as { rich_message: { blocks: InputRichBlock[] } };
          const blocks = request.rich_message.blocks;
          const media = blocks.reduce((total, block) => total + countInputRichBlockMedia(block), 0);
          if (countInputRichBlocks(blocks) > 500 || media > 50) {
            return new Response(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: "Bad Request: RICH_MESSAGE_LIMIT_EXCEEDED",
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          requests.push(request);
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: requests.length,
                date: 0,
                chat: { id: 1, type: "private" },
                text: "accepted",
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    const list = `<ul>${Array.from({ length: 250 }, (_, index) => `<li>item ${index}</li>`).join("")}</ul>`;
    const photos = Array.from(
      { length: 51 },
      (_, index) => `<img src="https://example.com/${index}.jpg"/>`,
    ).join("");
    const chunks = splitTelegramRichMessageTextChunks({
      text: `${list}\n\n<tg-collage>${photos}<figcaption>Album</figcaption></tg-collage>`,
      textLimit: 32_768,
    });

    for (const chunk of chunks) {
      await getTelegramRichRawApi(bot.api).sendRichMessage({
        chat_id: 1,
        rich_message: chunk.richMessage,
      });
    }

    const deliveredBlocks = requests.flatMap((request) => request.rich_message.blocks);
    const deliveredItems = deliveredBlocks.flatMap((block) =>
      block.type === "list" ? block.items : [],
    );
    const deliveredAlbums = deliveredBlocks.filter((block) => block.type === "collage");
    const deliveredPhotos = deliveredAlbums.flatMap((block) => block.blocks);

    expect(requests).toHaveLength(chunks.length);
    expect(
      requests.every((request) => countInputRichBlocks(request.rich_message.blocks) <= 500),
    ).toBe(true);
    expect(deliveredItems).toHaveLength(250);
    expect(deliveredPhotos).toHaveLength(51);
    expect(new Set(deliveredPhotos.map((block) => JSON.stringify(block))).size).toBe(51);
    expect(deliveredAlbums.flatMap((block) => (block.caption ? [block.caption.text] : []))).toEqual(
      ["Album"],
    );
  });
});
