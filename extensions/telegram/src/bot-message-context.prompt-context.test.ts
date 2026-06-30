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
});
