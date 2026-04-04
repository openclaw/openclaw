import type { Chat, Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import { getTelegramSequentialKey } from "./sequential-key.js";

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
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123:1"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9:1",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:1",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true }),
        }),
      },
      "telegram:123:topic:1:1",
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555:1"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) }),
      },
      "telegram:-100777111222:1",
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) }),
        },
      },
      "telegram:-100777111223:1",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) }, "telegram:123:1"],
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
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123:1"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123:1"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123:1",
    ],
    // per-message key: different message_ids produce different keys
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 42 } as Partial<Message>) },
      "telegram:123:42",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), message_id: 43 } as Partial<Message>) },
      "telegram:123:43",
    ],
    // fallback when no message is present (chat-only context)
    [{ chat: { id: 999 } }, "telegram:unknown"],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });
});
