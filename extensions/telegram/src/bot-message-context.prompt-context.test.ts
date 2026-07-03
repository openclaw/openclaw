import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

const telegramChatWindowContext: TelegramPromptContextEntry = {
  label: "Conversation context",
  source: "telegram",
  type: "chat_window",
  payload: {
    order: "chronological",
    relation: "selected_for_current_message",
    messages: [
      {
        message_id: "10",
        sender: "Pat",
        timestamp_ms: 1_700_000_000_000,
        body: "Earlier DM turn already in the transcript",
      },
    ],
  },
};

describe("buildTelegramMessageContext prompt context", () => {
  it("omits Telegram chat-window context for existing unthreaded private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "continue",
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.SessionKey).toBe("agent:main:main");
    expect(ctx?.ctxPayload.UntrustedStructuredContext).toBeUndefined();
  });

  it("keeps Telegram chat-window context for fresh private DM sessions", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "start",
      },
      promptContext: [telegramChatWindowContext],
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("keeps Telegram chat-window context for existing private DM replies", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "replying with context",
        reply_to_message: {
          chat: { id: 1234, type: "private", first_name: "Pat" },
          from: { id: 1234, first_name: "Pat" },
          text: "older referenced turn",
          date: 1_700_000_000,
          message_id: 10,
        },
      },
      promptContext: [telegramChatWindowContext],
      sessionRuntime: {
        readSessionUpdatedAt: ({ sessionKey }) =>
          sessionKey === "agent:main:main" ? 1_700_000_000_000 : undefined,
      },
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([telegramChatWindowContext]);
  });

  it("preserves richer chat-window fields when merging duplicate group history", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 11,
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 1234, first_name: "Pat" },
        text: "@bot continue",
        entities: [{ type: "mention", offset: 0, length: 4 }],
        message_thread_id: 99,
      },
      historyLimit: 10,
      groupHistories: new Map([
        [
          "-1001234567890:topic:99",
          [
            {
              messageId: "10",
              sender: "Pat",
              timestamp: 1_700_000_000_000,
              body: "Earlier with media",
            },
          ],
        ],
      ]),
      promptContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              {
                message_id: "10",
                sender: "Pat",
                timestamp_ms: 1_700_000_000_000,
                body: "Earlier with media",
                is_reply_target: true,
                media_type: "image/png",
                media_path: "media://inbound/screenshot.png",
              },
            ],
          },
        },
      ],
    });

    expect(ctx?.ctxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              message_id: "10",
              is_reply_target: true,
              media_type: "image/png",
              media_path: "media://inbound/screenshot.png",
            }),
          ],
        }),
      }),
    ]);
  });
});
