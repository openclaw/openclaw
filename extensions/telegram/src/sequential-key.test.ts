import type { Chat, Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import { getTelegramSequentialKey, type TelegramSequentialKeyOptions } from "./sequential-key.js";

const mockChat = (chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum">>): Chat =>
  chat as Chat;
const mockMessage = (message: Pick<Message, "chat"> & Partial<Message>): Message =>
  ({
    message_id: 1,
    date: 0,
    ...message,
  }) as Message;

describe("getTelegramSequentialKey", () => {
  it.each([
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        }),
      },
      "telegram:123:topic:1",
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      },
      "telegram:-100777111222",
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      },
      "telegram:-100777111223",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/btw@openclaw_bot what is the time?",
        }),
      },
      "telegram:123:btw:1",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "do not do that" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "остановись" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "halt" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123",
    ],
    // fallback when no message is present (chat-only context — no messageId suffix)
    [{ chat: { id: 999 } }, "telegram:999"],
  ])("resolves key (no active run) %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });

  const runActive: TelegramSequentialKeyOptions = { isRunActiveForChat: () => true };
  const runInactive: TelegramSequentialKeyOptions = { isRunActiveForChat: () => false };

  // per-message key: only when isRunActiveForChat returns true
  it.each([
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 42 }) },
      runActive,
      "telegram:123:42",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 43 }) },
      runActive,
      "telegram:123:43",
    ],
    // isRunActiveForChat returns false → per-chat key
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 42 }) },
      runInactive,
      "telegram:123",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 43 }) },
      runInactive,
      "telegram:123",
    ],
    // no opts at all → per-chat key
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 42 }) },
      undefined,
      "telegram:123",
    ],
  ])("resolves per-message key %#", (input, opts, expected) => {
    expect(getTelegramSequentialKey(input, opts)).toBe(expected);
  });

  it("passes threadId and senderId to isRunActiveForChat for forum topics", () => {
    const spy = { chatId: 0, threadId: undefined as number | undefined, senderId: undefined as number | undefined };
    const opts: TelegramSequentialKeyOptions = {
      isRunActiveForChat: (chatId, threadId, senderId) => {
        spy.chatId = chatId;
        spy.threadId = threadId;
        spy.senderId = senderId;
        return true;
      },
    };
    const input = {
      message: mockMessage({
        chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        message_thread_id: 7,
        message_id: 99,
        from: { id: 456, is_bot: false, first_name: "Test" },
      }),
    };
    const key = getTelegramSequentialKey(input, opts);
    expect(spy.chatId).toBe(123);
    expect(spy.threadId).toBe(7);
    expect(spy.senderId).toBe(456);
    expect(key).toBe("telegram:123:topic:7:99");
  });
});
