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
    it("detects mention via m.mentions.user_ids", () => {
      const result = resolveMentions({
        content: {
          msgtype: "m.text",
          body: "hello",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
        },
        userId,
        text: "hello",
        mentionRegexes,
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("detects room mention via m.mentions.room", () => {
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
      expect(result.wasMentioned).toBe(true);
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
