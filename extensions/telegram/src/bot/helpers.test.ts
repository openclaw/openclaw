import type { Message as TelegramMessage, MessageEntity } from "grammy/types";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
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
function externalTarget(reply: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return replyTarget(
    {},
    {
      reply_to_message: undefined,
      external_reply: {
        message_id: 4,
        date: 1200,
        chat,
        text: "Forwarded from elsewhere",
        ...reply,
      },
      ...extra,
    },
  );
}
const mentions = (text: string) =>
  hasBotMention(asMalformedTelegramMessage({ text, chat: { id: 1, type: "supergroup" } }), "gaian");

describe("describeReplyTarget", () => {
  it("handles non-string reply text gracefully (issue #27201)", () => {
    expect(replyTarget({ text: { some: "object" } })).toBeNull();
  });

  it("describes a replied-to dice roll when the cache did not supply a body", () => {
    expect(replyTarget({ dice: { emoji: "\u{1F3AF}", value: 3 } })).toMatchObject({
      body: "[Dice \u{1F3AF} = 3]",
      sender: "Alice",
    });
  });

  it("drops binary reply captions with no safe fallback", () => {
    expect(replyTarget({ caption: "PK\x00\x03\x04binary" })).toMatchObject({
      id: "1",
      sender: "Alice",
      body: undefined,
    });
  });

  it("falls back to reply text when quote text is binary", () => {
    expect(
      replyTarget(
        { text: "Original message" },
        {
          quote: { text: "\x00\x01\x02binary quote" },
        },
      ),
    ).toMatchObject({ body: "Original message", kind: "reply" });
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
    const result = externalTarget(
      { from: { id: 123, first_name: "Eve", is_bot: false } },
      {
        quote: {
          text: "quoted slice",
          position: 4,
          entities: [{ type: "italic", offset: 0, length: 6 }],
        },
      },
    );

    expect(result).toMatchObject({
      id: "4",
      kind: "quote",
      source: "external_reply",
      quoteText: "quoted slice",
      quotePosition: 4,
    });
    expect(result?.quoteEntities).toEqual([{ type: "italic", offset: 0, length: 6 }]);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = externalTarget({
      forward_origin: {
        type: "user",
        sender_user: {
          id: 123,
          first_name: "Eve",
          last_name: "Stone",
          username: "eve",
          is_bot: false,
        },
        date: 700,
      },
    });
    expect(result?.id).toBe("4");
    expect(result?.forwardedFrom).toMatchObject({
      from: "Eve Stone (@eve)",
      fromType: "user",
      fromId: "123",
      date: 700,
    });
  });
});

describe("getTelegramTextParts — binary caption filtering (#66647)", () => {
  it("strips binary caption content to prevent token explosion", () => {
    const binaryCaption = "PK\x03\x04\x14\x00\x08binary-ebook-data";
    const result = getTelegramTextParts({
      caption: binaryCaption,
      caption_entities: [{ type: "mention", offset: 0, length: 5 }],
      chat: { id: 1, type: "private" },
      date: 1,
      message_id: 1,
    } as TelegramMessage);
    expect(result.text).toBe("");
    expect(result.entities).toStrictEqual([]);
  });
});

describe("hasBotMention", () => {
  it("does not match mention prefixes from longer bot usernames", () => {
    expect(mentions("@GaianChat_Bot what is the group id?")).toBe(false);
  });

  it("matches mention followed by punctuation", () => {
    expect(mentions("@gaian, what's up?")).toBe(true);
  });

  it("matches a text_mention that targets the bot in a caption", () => {
    expect(
      hasBotMention(
        asMalformedTelegramMessage({
          caption: "Gaian look at this",
          caption_entities: [
            {
              type: "text_mention",
              offset: 0,
              length: 5,
              user: { id: 42, is_bot: true, first_name: "Gaian" },
            },
          ],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        42,
      ),
    ).toBe(true);
  });
});

describe("renderTelegramTextEntities", () => {
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
