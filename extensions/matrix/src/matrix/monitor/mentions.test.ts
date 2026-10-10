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

  function resolve(
    content: Parameters<typeof resolveMentions>[0]["content"],
    overrides: Partial<Omit<Parameters<typeof resolveMentions>[0], "content">> = {},
  ) {
    return resolveMentions({ content, userId, text: content.body, mentionRegexes, ...overrides });
  }

  describe("m.mentions field", () => {
    it.each<[label: string, mentionedUserId: string, body: string]>([
      ["localpart shorthand", "@bot:matrix.org", "hello @bot"],
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
      ["extended dotted localpart", "hello @bot.extra"],
      ["embedded email token", "hello contact@bot"],
      ["zero-width foreign homeserver", "hello @bot\u200b:evil.example"],
    ])("rejects forged native mention metadata for %s", (_label, body) => {
      expect(
        resolve(
          {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: [userId] },
          },
          { text: body, mentionRegexes: [] },
        ),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
    });

    it("requires metadata to name the exact account even when that account is visibly mentioned", () => {
      const body = "hello @bot:matrix.org";

      expect(
        resolve(
          {
            msgtype: "m.text",
            body,
            "m.mentions": { user_ids: ["@bot:evil.example"] },
          },
          { text: body, mentionRegexes: [] },
        ),
      ).toEqual({ wasMentioned: false, hasExplicitMention: false });
    });

    it("does not trust forged m.mentions.room without visible @room text", () => {
      const result = resolve({
        msgtype: "m.text",
        body: "hello everyone",
        "m.mentions": { room: true },
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });

  function resolveFormatted(
    body: string,
    formatted_body: string,
    overrides: Partial<Omit<Parameters<typeof resolveMentions>[0], "content">> = {},
  ) {
    return resolve(
      { msgtype: "m.text", body, formatted_body },
      { mentionRegexes: [], ...overrides },
    );
  }

  describe("formatted_body matrix.to links", () => {
    it("does not false-positive on partial user ID match", () => {
      const result = resolveFormatted(
        "Bot2: hello",
        '<a href="https://matrix.to/#/@bot2:matrix.org">Bot2</a>: hello',
      );
      expect(result.wasMentioned).toBe(false);
    });

    it("does not trust hidden matrix.to links behind unrelated visible text", () => {
      const result = resolveFormatted(
        "click here: hello",
        '<a href="https://matrix.to/#/@bot:matrix.org">click here</a>: hello',
      );
      expect(result.wasMentioned).toBe(false);
    });

    it("detects mention when the visible label encodes the bot's displayName", () => {
      const result = resolveFormatted(
        "R&D Bot: hello",
        '<a href="https://matrix.to/#/@bot:matrix.org">R&amp;D Bot</a>: hello',
        { displayName: "R&D Bot" },
      );
      expect(result.wasMentioned).toBe(true);
    });

    it("ignores oversized decimal HTML entities in visible labels", () => {
      expect(
        resolveFormatted(
          "hello",
          '<a href="https://matrix.to/#/@bot:matrix.org">&#9999999999999999999999999999999999999999;</a>: hello',
        ),
      ).toEqual({ hasExplicitMention: false, wasMentioned: false });
    });
  });
});
