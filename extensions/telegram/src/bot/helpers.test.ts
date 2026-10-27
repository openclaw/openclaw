import type { Message as TelegramMessage, MessageEntity } from "grammy/types";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it, vi } from "vitest";
import { describeReplyTarget, getTelegramTextParts, hasBotMention } from "./helpers.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

function asMalformedTelegramMessage(message: unknown): TelegramMessage {
  return message as TelegramMessage;
}

const chat = { id: 1, type: "private" } as const;
const alice = { id: 42, first_name: "Alice", is_bot: false };
function replyTarget(reply: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return describeReplyTarget(
    asMalformedTelegramMessage({
      message_id: 2,
      date: 1000,
      chat,
      reply_to_message: { message_id: 1, date: 900, chat, from: alice, ...reply },
      ...extra,
    }),
  );
}

describe("describeReplyTarget", () => {
  it("handles non-string reply text gracefully (issue #27201)", () => {
    expect(replyTarget({ text: { some: "object" } })).toBeNull();
  });

  it.each([
    {
      name: "describes uncached dice rolls",
      reply: { dice: { emoji: "🎯", value: 3 } },
      extra: {},
      expected: { body: "[Dice 🎯 = 3]", sender: "Alice" },
    },
    {
      name: "falls back from binary quotes to reply text",
      reply: { text: "Original message" },
      extra: { quote: { text: "\x00\x01\x02binary quote" } },
      expected: { body: "Original message", kind: "reply" },
    },
  ])("$name", ({ reply, extra, expected }) => {
    expect(replyTarget(reply, extra)).toMatchObject(expected);
  });

  it("extracts forwarded context from channel forward in reply_to_message", () => {
    const result = replyTarget({
      text: "Channel post content here",
      forward_origin: {
        type: "channel",
        chat: { id: -1001234567, title: "Tech News", username: "technews", type: "channel" },
        date: 800,
        message_id: 456,
        author_signature: "Editor",
      },
    });
    expect(result?.forwardedFrom).toMatchObject({
      from: "Tech News (Editor)",
      fromType: "channel",
      fromMessageId: 456,
    });
  });

  it("marks top-level quote metadata on external replies as external targets", () => {
    const entities = [{ type: "italic", offset: 0, length: 6 }];
    const result = replyTarget(
      {},
      {
        reply_to_message: undefined,
        external_reply: {
          message_id: 4,
          date: 1200,
          chat,
          text: "Forwarded from elsewhere",
          from: { id: 123, first_name: "Eve", is_bot: false },
        },
        quote: { text: "quoted slice", position: 4, entities },
      },
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: "4",
        kind: "quote",
        source: "external_reply",
        quoteText: "quoted slice",
        quotePosition: 4,
        quoteEntities: entities,
      }),
    );
  });
});

it("strips binary captions and their entities to prevent token explosion (#66647)", () => {
  expect(
    getTelegramTextParts({
      caption: "PK\x03\x04\x14\x00\x08binary-ebook-data",
      caption_entities: [{ type: "mention", offset: 0, length: 5 }],
    }),
  ).toStrictEqual({ text: "", entities: [] });
});

it.each([
  [{ text: "@GaianChat_Bot what is the group id?" }, false],
  [{ text: "@gaian, what's up?" }, true],
  [
    {
      caption: "Gaian look at this",
      caption_entities: [
        {
          type: "text_mention",
          offset: 0,
          length: 5,
          user: { id: 42, is_bot: true, first_name: "Gaian" },
        },
      ],
    },
    true,
  ],
] as const)("matches only the target bot in %j", (content, expected) => {
  const message = asMalformedTelegramMessage({ chat: { id: 1, type: "supergroup" }, ...content });
  expect(hasBotMention(message, "gaian", 42)).toBe(expected);
});

describe("renderTelegramTextEntities", () => {
  it("orders owned boundaries without copying or mutating caller entities", () => {
    const text = "bold before\nquoted\nbold after";
    const entities = Object.freeze([
      Object.freeze({ type: "italic", offset: 12, length: 6 } as const),
      Object.freeze({ type: "bold", offset: 0, length: text.length } as const),
      Object.freeze({ type: "blockquote", offset: 12, length: 6 } as const),
      Object.freeze({ type: "bold", offset: -1, length: 6 } as const),
    ]);
    const copyingSort = vi.spyOn(Array.prototype, "toSorted");
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(renderTelegramTextEntities(text, entities)).toBe(
          "**bold before**\n> **_quoted_**\n\n**bold after**",
        );
      }
      expect(copyingSort).not.toHaveBeenCalled();
    } finally {
      copyingSort.mockRestore();
    }
  });

  it("uses a pre fence that cannot close inside content", () => {
    const text = "before\n```\ninside";
    const entities = [
      { type: "pre", offset: 0, length: text.length, language: "md" },
    ] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe("````md\nbefore\n```\ninside\n````");
  });

  it("preserves a literal destination backslash through the actual Markdown parser", () => {
    const label = "docs";
    const url = String.raw`https://example.com/a\b)`;
    const text = `Read ${label} now`;
    const offset = "Read ".length;
    const entities = [
      { type: "bold", offset, length: label.length },
      { type: "text_link", offset, length: label.length, url },
    ] satisfies MessageEntity[];

    const parsed = markdownToIR(renderTelegramTextEntities(text, entities));

    expect(parsed.text).toBe(text);
    expect(parsed.links).toEqual([
      { start: offset, end: offset + label.length, href: "https://example.com/a%5Cb)" },
    ]);
    expect(parsed.styles).toContainEqual({
      start: offset,
      end: offset + label.length,
      style: "bold",
    });
  });
});
