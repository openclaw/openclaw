import { describe, expect, it } from "vitest";
import {
  mergeTelegramPromptContextMessages,
  resolvePromptContextTextDedupeKey,
} from "./prompt-context-dedupe.js";

describe("resolvePromptContextTextDedupeKey", () => {
  it("matches assistant transcript text to Telegram cache text after stripping directive tags", () => {
    expect(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "[[reply_to_current]]Yep - I'm here now.",
      }),
    ).toBe(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "Yep - I'm here now.",
      }),
    );
  });

  it("keeps timestamp alignment in the dedupe key", () => {
    expect(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_760_000,
        body: "[[reply_to_current]]Yep - I'm here now.",
      }),
    ).not.toBe(
      resolvePromptContextTextDedupeKey({
        timestamp_ms: 1_778_474_761_000,
        body: "Yep - I'm here now.",
      }),
    );
  });

  it("filters directive-tagged session rows when a cache row has the same visible text", () => {
    const result = mergeTelegramPromptContextMessages({
      sessionPromptMessages: [
        {
          message_id: "session:assistant-with-reply-directive",
          timestamp_ms: 1_778_474_760_000,
          body: "[[reply_to_current]]Yep - I'm here now.",
        },
      ],
      cachePromptMessages: [
        {
          message_id: "736",
          timestamp_ms: 1_778_474_760_000,
          body: "Yep - I'm here now.",
        },
      ],
    });

    expect(result.sessionOnlyPromptMessages).toEqual([]);
    expect(result.promptMessages).toEqual([
      {
        message_id: "736",
        timestamp_ms: 1_778_474_760_000,
        body: "Yep - I'm here now.",
      },
    ]);
  });

  it("keeps both session and cache rows when visible text matches but timestamps differ", () => {
    const result = mergeTelegramPromptContextMessages({
      sessionPromptMessages: [
        {
          message_id: "session:assistant-with-reply-directive",
          timestamp_ms: 1_778_474_760_000,
          body: "[[reply_to_current]]Yep - I'm here now.",
        },
      ],
      cachePromptMessages: [
        {
          message_id: "736",
          timestamp_ms: 1_778_474_761_000,
          body: "Yep - I'm here now.",
        },
      ],
    });

    expect(result.sessionOnlyPromptMessages).toHaveLength(1);
    expect(result.promptMessages.map((message) => message.message_id)).toEqual([
      "session:assistant-with-reply-directive",
      "736",
    ]);
  });
});
