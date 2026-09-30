// Telegram tests cover helpers plugin behavior.
import type { Message as TelegramMessage, MessageEntity } from "grammy/types";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { describeReplyTarget, getTelegramTextParts, hasBotMention } from "./helpers.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

function asMalformedTelegramMessage(message: unknown): TelegramMessage {
  return message as TelegramMessage;
}

describe("describeReplyTarget", () => {
  it("handles non-string reply text gracefully (issue #27201)", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private", first_name: "Test" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private", first_name: "Test" },
          // Simulate edge case where text is an unexpected non-string value
          text: { some: "object" },
          from: { id: 42, first_name: "Alice", is_bot: false },
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("describes a replied-to dice roll when the cache did not supply a body", () => {
    // A dice roll has neither text nor media, so before it was normalized here the whole
    // target resolved to null and a reply to the roll reached the agent without it.
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private" },
          from: { id: 42, first_name: "Alice", is_bot: false },
          dice: { emoji: "\u{1F3AF}", value: 3 },
        },
      }),
    );
    expect(result?.body).toBe("[Dice \u{1F3AF} = 3]");
    expect(result?.sender).toBe("Alice");
  });

  it("falls back to caption when reply text is malformed", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private", first_name: "Test" },
        reply_to_message: {
          message_id: 1,
          date: 900,
          chat: { id: 1, type: "private", first_name: "Test" },
          text: { some: "object" },
          caption: "Caption body",
          from: { id: 42, first_name: "Alice", is_bot: false },
        },
      }),
    );
    expect(result?.body).toBe("Caption body");
    expect(result?.kind).toBe("reply");
  });

  it("drops binary reply captions with no safe fallback", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        caption: "PK\x00\x03\x04binary",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as TelegramMessage);
    expect(result?.id).toBe("1");
    expect(result?.sender).toBe("Alice");
    expect(result?.body).toBeUndefined();
  });

  it("falls back to reply text when quote text is binary", () => {
    const result = describeReplyTarget({
      message_id: 2,
      date: 1000,
      chat: { id: 1, type: "private" },
      quote: {
        text: "\x00\x01\x02binary quote",
      },
      reply_to_message: {
        message_id: 1,
        date: 900,
        chat: { id: 1, type: "private" },
        text: "Original message",
        from: { id: 42, first_name: "Alice", is_bot: false },
      },
    } as TelegramMessage);
    expect(result?.body).toBe("Original message");
    expect(result?.kind).toBe("reply");
  });

  it("falls back to external reply text when external quote text is binary", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
          quote: {
            text: "PK\x00\x03\x04binary quote",
          },
          from: { id: 123, first_name: "Eve", is_bot: false },
        },
      }),
    );
    expect(result?.body).toBe("Forwarded from elsewhere");
    expect(result?.kind).toBe("reply");
  });

  it("extracts forwarded context from reply_to_message (issue #9619)", () => {
    // When user forwards a message with a comment, the comment message has
    // reply_to_message pointing to the forwarded message. We should extract
    // the forward_origin from the reply target.
    const result = describeReplyTarget({
      message_id: 3,
      date: 1100,
      chat: { id: 1, type: "private" },
      text: "Here is my comment about this forwarded content",
      reply_to_message: {
        message_id: 2,
        date: 1000,
        chat: { id: 1, type: "private" },
        text: "This is the forwarded content",
        forward_origin: {
          type: "user",
          sender_user: {
            id: 999,
            first_name: "Bob",
            last_name: "Smith",
            username: "bobsmith",
            is_bot: false,
          },
          date: 500,
        },
      },
    } as TelegramMessage);
    expect(result?.body).toBe("This is the forwarded content");
    expect(result?.id).toBe("2");
    expect(result?.forwardedFrom?.from).toBe("Bob Smith (@bobsmith)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("999");
    expect(result?.forwardedFrom?.date).toBe(500);
  });

  it("extracts forwarded context from channel forward in reply_to_message", () => {
    const result = describeReplyTarget({
      message_id: 4,
      date: 1200,
      chat: { id: 1, type: "private" },
      text: "Interesting article!",
      reply_to_message: {
        message_id: 3,
        date: 1100,
        chat: { id: 1, type: "private" },
        text: "Channel post content here",
        forward_origin: {
          type: "channel",
          chat: { id: -1001234567, title: "Tech News", username: "technews", type: "channel" },
          date: 800,
          message_id: 456,
          author_signature: "Editor",
        },
      },
    } as TelegramMessage);
    expect(result?.forwardedFrom?.from).toBe("Tech News (Editor)");
    expect(result?.forwardedFrom?.fromType).toBe("channel");
    expect(result?.forwardedFrom?.fromMessageId).toBe(456);
  });

  it("marks top-level quote metadata on external replies as external targets", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        quote: {
          text: "quoted slice",
          position: 4,
          entities: [{ type: "italic", offset: 0, length: 6 }],
        },
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
          from: { id: 123, first_name: "Eve", is_bot: false },
        },
      }),
    );

    expect(result?.id).toBe("4");
    expect(result?.kind).toBe("quote");
    expect(result?.source).toBe("external_reply");
    expect(result?.quoteText).toBe("quoted slice");
    expect(result?.quotePosition).toBe(4);
    expect(result?.quoteEntities).toEqual([{ type: "italic", offset: 0, length: 6 }]);
  });

  it("extracts forwarded context from external_reply", () => {
    const result = describeReplyTarget(
      asMalformedTelegramMessage({
        message_id: 5,
        date: 1300,
        chat: { id: 1, type: "private" },
        text: "Comment on forwarded message",
        external_reply: {
          message_id: 4,
          date: 1200,
          chat: { id: 1, type: "private" },
          text: "Forwarded from elsewhere",
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
        },
      }),
    );
    expect(result?.id).toBe("4");
    expect(result?.forwardedFrom?.from).toBe("Eve Stone (@eve)");
    expect(result?.forwardedFrom?.fromType).toBe("user");
    expect(result?.forwardedFrom?.fromId).toBe("123");
    expect(result?.forwardedFrom?.date).toBe(700);
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

  it("strips binary content in msg.text as well", () => {
    const result = getTelegramTextParts({
      text: "\x00\x01\x02 binary junk",
      entities: [{ type: "bold", offset: 0, length: 3 }],
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
    expect(
      hasBotMention(
        {
          text: "@GaianChat_Bot what is the group id?",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(false);
  });

  it("matches mention followed by punctuation", () => {
    expect(
      hasBotMention(
        {
          text: "@gaian, what's up?",
          chat: { id: 1, type: "supergroup" },
        } as TelegramMessage,
        "gaian",
      ),
    ).toBe(true);
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

  it("does not match (and does not throw) a text_mention entity with no user", () => {
    expect(
      hasBotMention(
        asMalformedTelegramMessage({
          text: "Gaian hello",
          entities: [{ type: "text_mention", offset: 0, length: 5 }],
          chat: { id: 1, type: "supergroup" },
        }),
        "gaian",
        42,
      ),
    ).toBe(false);
  });
});

describe("renderTelegramTextEntities", () => {
  it("renders Telegram formatting entities as markdown", () => {
    const text = "bold italic code strike underline spoiler";
    const entities = [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 5, length: 6 },
      { type: "code", offset: 12, length: 4 },
      { type: "strikethrough", offset: 17, length: 6 },
      { type: "underline", offset: 24, length: 9 },
      { type: "spoiler", offset: 34, length: 7 },
    ] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe(
      "**bold** _italic_ `code` ~~strike~~ __underline__ ||spoiler||",
    );
  });

  it("renders pre entities with language fences", () => {
    const text = "const value = 1;";
    const entities = [
      { type: "pre", offset: 0, length: text.length, language: "ts" },
    ] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe("```ts\nconst value = 1;\n```");
  });

  it("uses a pre fence that cannot close inside content", () => {
    const text = "before\n```\ninside";
    const entities = [
      { type: "pre", offset: 0, length: text.length, language: "md" },
    ] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe("````md\nbefore\n```\ninside\n````");
  });

  it("renders links and formatting from original offsets", () => {
    const text = "Read docs now";
    const entities = [
      { type: "bold", offset: 5, length: 4 },
      { type: "text_link", offset: 5, length: 4, url: "https://docs.example" },
      { type: "italic", offset: 10, length: 3 },
    ] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe(
      "Read **[docs](https://docs.example)** _now_",
    );
  });

  it("uses UTF-16 Telegram offsets", () => {
    const text = "Hi 😀 bold";
    const entities = [{ type: "bold", offset: 6, length: 4 }] satisfies MessageEntity[];

    expect(renderTelegramTextEntities(text, entities)).toBe("Hi 😀 **bold**");
  });

  it.each([
    {
      description: "an unmatched closing parenthesis",
      label: "docs",
      url: "https://example.com/report)final",
      expectedHref: "https://example.com/report)final",
    },
    {
      description: "nested and trailing parentheses",
      label: "docs",
      url: "https://example.com/quarter(a)b)",
      expectedHref: "https://example.com/quarter(a)b)",
    },
    {
      description: "a literal destination backslash",
      label: "docs",
      url: String.raw`https://example.com/a\b)`,
      expectedHref: "https://example.com/a%5Cb)",
    },
    {
      description: "angle brackets and whitespace",
      label: "docs",
      url: "https://example.com/<report final>",
      expectedHref: "https://example.com/%3Creport%20final%3E",
    },
    {
      description: "a closing bracket in the linked label",
      label: "docs]more",
      url: "https://example.com/report)final",
      expectedHref: "https://example.com/report)final",
    },
    {
      description: "a literal backslash before a bracket in the linked label",
      label: String.raw`docs\]more`,
      url: "https://example.com/report)final",
      expectedHref: "https://example.com/report)final",
    },
    {
      description: "an opening bracket and UTF-16 emoji in the linked label",
      label: "😀 [docs",
      url: "https://example.com/report)final",
      expectedHref: "https://example.com/report)final",
    },
    {
      description: "a newline in a provider link destination",
      label: "docs",
      url: "https://example.com/report\nfinal",
      expectedHref: "https://example.com/report%0Afinal",
    },
    {
      description: "an already percent-encoded parenthesis",
      label: "docs",
      url: "https://example.com/report%29final",
      expectedHref: "https://example.com/report%29final",
    },
  ])(
    "preserves $description through the actual Markdown parser",
    ({ label, url, expectedHref }) => {
      const text = `Read ${label} now`;
      const offset = "Read ".length;
      const entities = [
        { type: "bold", offset, length: label.length },
        { type: "text_link", offset, length: label.length, url },
      ] satisfies MessageEntity[];

      const parsed = markdownToIR(renderTelegramTextEntities(text, entities));

      expect(parsed.text).toBe(text);
      expect(parsed.links).toEqual([
        { start: offset, end: offset + label.length, href: expectedHref },
      ]);
      expect(parsed.styles).toContainEqual({
        start: offset,
        end: offset + label.length,
        style: "bold",
      });
    },
  );
});
