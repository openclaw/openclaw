import type { webhook } from "@line/bot-sdk";
import { describe, expect, it } from "vitest";
import { resolveLineMentionStrippedText } from "./mentions.js";

type MessageContent = webhook.MessageEvent["message"];

const textMessage = (text: string, mentionees: webhook.Mentionee[] = []): MessageContent =>
  ({
    id: "m-1",
    type: "text",
    text,
    quoteToken: "quote-token",
    ...(mentionees.length > 0 ? { mention: { mentionees } } : {}),
  }) satisfies webhook.TextMessageContent;

const selfMention = (index: number, length: number): webhook.Mentionee => ({
  type: "user",
  index,
  length,
  userId: "Ubot",
  isSelf: true,
});

const memberMention = (index: number, length: number): webhook.Mentionee => ({
  type: "user",
  index,
  length,
  userId: "Umember",
  isSelf: false,
});

describe("resolveLineMentionStrippedText", () => {
  it("uses LINE's UTF-16 offsets, so an astral character before the mention does not shift it", () => {
    // LINE counts webhook text in UTF-16 code units, so "🍎" occupies two of
    // them and the mention starts at index 3 — the same unit `slice` uses.
    const message = textMessage("🍎 @openclaw3 /status", [selfMention(3, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("🍎  /status");
  });

  it("keeps another member's mention, which is not addressed to the bot", () => {
    const message = textMessage("@Alice @openclaw3 /status", [
      memberMention(0, 6),
      selfMention(7, 10),
    ]);

    expect(resolveLineMentionStrippedText(message)).toBe("@Alice  /status");
  });

  it("does not join text around an inline bot mention into a new command", () => {
    const message = textMessage("/re@openclaw3set", [selfMention(3, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("/re set");
  });

  it("removes an @all mention, which addresses the bot like a direct mention", () => {
    const message = textMessage("@All /status", [{ type: "all", index: 0, length: 4 }]);

    expect(resolveLineMentionStrippedText(message)).toBe("/status");
  });

  it("keeps a command's multi-line tail intact", () => {
    const message = textMessage("@openclaw3 /think hard\nsecond line", [selfMention(0, 10)]);

    expect(resolveLineMentionStrippedText(message)).toBe("/think hard\nsecond line");
  });
});
