// Matrix tests cover mentions plugin behavior.
import { describe, expect, it, vi } from "vitest";

// Mock the runtime before importing resolveMentions
vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      mentions: {
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((p) => p.test(text)),
      },
    },
  }),
}));

import { resolveMentions } from "./mentions.js";

describe("resolveMentions", () => {
  const userId = "@bot:matrix.org";
  const mentionRegexes = [/@bot/i];

  describe("m.mentions field", () => {
    it("detects mention via m.mentions.user_ids when the visible text also mentions the bot", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello @bot",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        text: "hello @bot",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it.each<[label: string, mentionedUserId: string, body: string]>([
      ["full Matrix user ID", "@bot:matrix.org", "hello @bot:matrix.org"],
      ["colon-delimited full Matrix user ID", "@bot:matrix.org", "@bot:matrix.org: help"],
      [
        "Unicode-whitespace-colon-delimited full Matrix user ID",
        "@bot:matrix.org",
        "@bot:matrix.org:\u2003help",
      ],
      [
        "colon-delimited full Matrix user ID with a homeserver port",
        "@bot:matrix.org:8448",
        "@bot:matrix.org:8448: help",
      ],
      ["localpart shorthand", "@bot:matrix.org", "hello @bot"],
      ["colon-delimited shorthand", "@bot:matrix.org", "@bot: hello"],
      ["Unicode-whitespace-delimited shorthand", "@bot:matrix.org", "hello\u2003@bot\u2003thanks"],
      ["sentence-ending full Matrix user ID", "@bot:matrix.org", "hello @bot:matrix.org,"],
      ["special localpart characters", "@foo/bar+baz=ok:matrix.org", "hello @foo/bar+baz=ok"],
      ["historical Unicode localpart", "@böt中:matrix.org", "hello @böt中"],
      ["historical punctuation localpart", "@b!o%t&=x:matrix.org", "hello @b!o%t&=x"],
      [
        "historical punctuation in a full Matrix user ID",
        "@b!o%t&=x:matrix.org",
        "hello @b!o%t&=x:matrix.org",
      ],
      [
        "bracketed IPv6 homeserver and port",
        "@bot:[2001:db8::1]:8448",
        "hello @bot:[2001:db8::1]:8448",
      ],
      [
        "colon-delimited bracketed IPv6 homeserver and port",
        "@bot:[2001:db8::1]:8448",
        "@bot:[2001:db8::1]:8448:\u2003help",
      ],
    ])(
      "detects native plain-text %s without configured mention patterns",
      (_label, mentionedUserId, body) => {
        const params = {
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: [mentionedUserId] },
          },
          userId: mentionedUserId,
          text: body,
          mentionRegexes: [],
        };
        expect(resolveMentions(params)).toEqual({ wasMentioned: true, hasExplicitMention: true });
      },
    );

    it.each<[label: string, body: string]>([
      ["same localpart on another homeserver", "hello @bot:evil.example"],
      ["case-different homeserver", "hello @bot:MATRIX.ORG"],
      ["extended DNS homeserver", "hello @bot:matrix.org.evil"],
      ["unexpected homeserver port", "hello @bot:matrix.org:8448"],
      ["unexpected homeserver port before a command", "@bot:matrix.org:8448: help"],
      ["unexpected repeated homeserver colon", "@bot:matrix.org::8448"],
      ["full Matrix user ID followed by colon alone", "@bot:matrix.org:"],
      ["full Matrix user ID followed by invisible BOM", "@bot:matrix.org:\ufeffhelp"],
      ["full Matrix user ID followed by invisible zero-width text", "@bot:matrix.org:\u200bhelp"],
      ["full Matrix user ID followed by bidirectional formatting", "@bot:matrix.org:\u202ehelp"],
      ["full Matrix user ID followed by a hidden control", "@bot:matrix.org:\u0001help"],
      ["alternate IPv6 homeserver", "hello @bot:[::1]"],
      ["extended dotted localpart", "hello @bot.extra"],
      ["extended plus localpart", "hello @bot+evil"],
      ["extended hyphenated localpart", "hello @bot-evil"],
      ["extended slash localpart", "hello @bot/evil"],
      ["historical exclamation localpart", "hello @bot!evil:evil.example"],
      ["historical percent localpart", "hello @bot%evil:evil.example"],
      ["historical ampersand localpart", "hello @bot&evil:evil.example"],
      ["historical question-mark localpart", "hello @bot?evil:evil.example"],
      ["historical closing-bracket localpart", "hello @bot)evil:evil.example"],
      ["historical Markdown localpart", "hello @bot**evil:evil.example"],
      ["historical exclamation-only localpart", "hello @bot!"],
      ["historical percent-only localpart", "hello @bot%"],
      ["historical comma-only localpart", "hello @bot,"],
      ["historical period-only localpart", "hello @bot."],
      ["historical parenthesis-only localpart", "hello @bot)"],
      ["historical Markdown-only localpart", "hello @bot**"],
      ["historical hash-only localpart", "hello @bot#"],
      ["ambiguous parenthesized shorthand", "hello (@bot)"],
      ["ambiguous Markdown-wrapped shorthand", "hello **@bot**"],
      ["ambiguous hash-wrapped shorthand", "hello #@bot#"],
      ["Matrix room-alias account collision", "hello #@bot:matrix.org"],
      ["Matrix room-alias colon-command collision", "#@bot:matrix.org: help"],
      ["Matrix room-ID account collision", "hello !@bot:matrix.org"],
      ["Matrix event-ID account collision", "hello $@bot:matrix.org"],
      ["unseparated Unicode punctuation", "hello （@bot），thanks"],
      ["extended accented localpart", "hello @boté"],
      ["extended CJK localpart", "hello @bot中"],
      ["extended combining-mark localpart", "hello @bot\u0301"],
      ["extended Unicode-numeral localpart", "hello @bot\u0661"],
      ["extended Unicode-connector localpart", "hello @bot\u203fevil"],
      ["extended currency-symbol localpart", "hello @bot€"],
      ["extended ASCII-currency localpart", "hello @bot$"],
      ["extended mathematical-symbol localpart", "hello @bot∑"],
      ["extended emoji localpart", "hello @bot\u{1f600}"],
      ["extended reserved emoji localpart", "hello @bot\u{1f02c}"],
      ["extended flag-emoji localpart", "hello @bot\u{1f1fa}\u{1f1f8}"],
      ["extended emoji-modifier localpart", "hello @bot\u{1f3fb}"],
      ["extended joined-emoji localpart", "hello @bot\u200d\u{1f4bb}"],
      ["extended Unicode homeserver", "hello @bot:matrix.orgé"],
      ["embedded email token", "hello contact@bot"],
      ["embedded opening-punctuation token", "hello evil(@bot"],
      ["embedded Markdown token", "hello evil**@bot"],
      ["embedded zero-width prefix", "hello \u200b@bot"],
      ["embedded BOM prefix", "hello \ufeff@bot"],
      ["embedded accented token", "hello é@bot"],
      ["embedded CJK token", "hello 中@bot"],
      ["embedded combining-mark token", "hello \u0301@bot"],
      ["embedded Unicode-numeral token", "hello \u0661@bot"],
      ["embedded Unicode-connector token", "hello \u203f@bot"],
      ["embedded currency-symbol token", "hello €@bot"],
      ["embedded mathematical-symbol token", "hello ∑@bot"],
      ["embedded emoji token", "hello \u{1f600}@bot"],
      ["embedded flag-emoji token", "hello \u{1f1fa}@bot"],
      ["embedded emoji-modifier token", "hello \u{1f3fb}@bot"],
      ["adjacent mention prefix", "hello @@bot"],
      ["zero-width foreign homeserver", "hello @bot\u200b:evil.example"],
      ["zero-width domain extension", "hello @bot:matrix.org\u200b.evil"],
      ["bidirectional foreign homeserver", "hello @bot\u202e:evil.example"],
      ["BOM foreign homeserver", "hello @bot\ufeff:evil.example"],
      ["invisible combining grapheme joiner", "hello @bot\u034f:evil.example"],
      ["invisible variation selector", "hello @bot\ufe0f:evil.example"],
      ["invisible Hangul filler", "hello @bot\u3164:evil.example"],
    ])("rejects forged native mention metadata for %s", (_label, body) => {
      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: [userId] },
          },
          userId,
          text: body,
          mentionRegexes: [],
        }),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
    });

    it.each([
      ...Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).filter(
        (character) => character !== ":",
      ),
      "！",
      "％",
      "，",
      "。",
      "؛",
      "‽",
      "・",
      "、",
      "…",
      "—",
      "（",
      "）",
      "«",
      "»",
    ])("rejects historical-account continuation or prefix %s", (character) => {
      for (const body of [
        `hello @bot${character}`,
        `hello @bot${character}${character}`,
        `hello @bot${character}evil:evil.example`,
        `hello evil${character}@bot`,
      ]) {
        expect(
          resolveMentions({
            content: {
              msgtype: "m.text",
              body,
              "m.mentions": { user_ids: [userId] },
            },
            userId,
            text: body,
            mentionRegexes: [],
          }),
        ).toEqual({ wasMentioned: false, hasExplicitMention: false });
      }
    });

    it("requires metadata to name the exact account even when that account is visibly mentioned", () => {
      const body = "hello @bot:matrix.org";

      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: ["@bot:evil.example"] },
          },
          userId,
          text: body,
          mentionRegexes: [],
        }),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
    });

    it("does not trust m.mentions.user_ids without a visible text or formatted mention", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "please reply",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        text: "please reply",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });

    it("detects room mention via visible @room text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@room hello everyone",
          "m.mentions": { room: true },
        },
        userId,
        text: "@room hello everyone",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not trust forged m.mentions.room without visible @room text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello everyone",
          "m.mentions": { room: true },
        },
        userId,
        text: "hello everyone",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });

  describe("formatted_body matrix.to links", () => {
    it("detects mention in formatted_body with plain user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Bot</a>: hello',
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention in formatted_body with URL-encoded user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/%40bot%3Amatrix.org">Bot</a>: hello',
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention with single quotes in href", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot: hello",
          formatted_body: "<a href='https://matrix.to/#/@bot:matrix.org'>Bot</a>: hello",
        },
        userId,
        text: "Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not detect mention for different user ID", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Other: hello",
          formatted_body: '<a href="https://matrix.to/#/@other:matrix.org">Other</a>: hello',
        },
        userId,
        text: "Other: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not false-positive on partial user ID match", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Bot2: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot2:matrix.org">Bot2</a>: hello',
        },
        userId: "@bot:matrix.org",
        text: "Bot2: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not trust hidden matrix.to links behind unrelated visible text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "click here: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">click here</a>: hello',
        },
        userId,
        text: "click here: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("detects mention when the visible label still names the bot", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@bot: hello",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:matrix.org"><span>@bot</span></a>: hello',
        },
        userId,
        text: "@bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label matches the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Wonderful Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Wonderful Bot</a>: hello',
        },
        userId,
        displayName: "Wonderful Bot",
        text: "Wonderful Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label encodes the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "R&D Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">R&amp;D Bot</a>: hello',
        },
        userId,
        displayName: "R&D Bot",
        text: "R&D Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label is @displayName with Unicode text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@欢欢 please reply",
          formatted_body:
            '<a href="https://matrix.to/#/@huanhuan:localhost">@欢欢</a> please reply',
          "m.mentions": { user_ids: ["@huanhuan:localhost"] },
        },
        userId: "@huanhuan:localhost",
        displayName: "欢欢",
        text: "@欢欢 please reply",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("detects mention when the visible label is bracketed @displayName text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "@[Display Name] please reply",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:matrix.org">@[Display Name]</a> please reply',
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        displayName: "Display Name",
        text: "@[Display Name] please reply",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("ignores out-of-range hexadecimal HTML entities in visible labels", () => {
      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body: "hello",
            formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">&#x110000;</a>: hello',
          },
          userId,
          text: "hello",
          mentionRegexes: [],
        }),
      ).toEqual({ hasExplicitMention: false, wasMentioned: false });
    });

    it("ignores oversized decimal HTML entities in visible labels", () => {
      expect(
        resolveMentions({
          content: {
            msgtype: "m.text",
            body: "hello",
            formatted_body:
              '<a href="https://matrix.to/#/@bot:matrix.org">&#9999999999999999999999999999999999999999;</a>: hello',
          },
          userId,
          text: "hello",
          mentionRegexes: [],
        }),
      ).toEqual({ hasExplicitMention: false, wasMentioned: false });
    });

    it("does not detect mention when displayName is spoofed", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "Spoofed Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Spoofed Bot</a>: hello',
        },
        userId,
        displayName: "Alice",
        text: "Spoofed Bot: hello",
        mentionRegexes: [],
      });
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe("regex patterns", () => {
    it("detects mention via regex pattern in body text", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hey @bot can you help?",
        },
        userId,
        text: "hey @bot can you help?",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
    });
  });

  describe("no mention", () => {
    it("returns false when no mention is present", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello world",
        },
        userId,
        text: "hello world",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });
});
