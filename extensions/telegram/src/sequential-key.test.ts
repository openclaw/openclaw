import type { Chat, Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
import { buildChatSessionCacheKey, getTelegramSequentialKey } from "./sequential-key.js";

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
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/commands" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/help" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/tools" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/tasks" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/context" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/whoami" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/export-session" }) },
      "telegram:123",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/export" }) }, "telegram:123"],
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
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });
});

describe("getTelegramSequentialKey with isRunActiveForChat bypass", () => {
  it("returns per-message key when run is active for the chat", () => {
    const key = getTelegramSequentialKey(
      {
        message: {
          message_id: 42,
          date: 0,
          chat: { id: 123, type: "private" } as Chat,
          from: { id: 999, first_name: "Test", is_bot: false },
        } as Message,
      },
      {
        isRunActiveForChat: () => true,
      },
    );
    expect(key).toBe("telegram:123:msg:42");
  });

  it("returns default key when run is NOT active", () => {
    const key = getTelegramSequentialKey(
      {
        message: {
          message_id: 42,
          date: 0,
          chat: { id: 123, type: "private" } as Chat,
          from: { id: 999, first_name: "Test", is_bot: false },
        } as Message,
      },
      {
        isRunActiveForChat: () => false,
      },
    );
    expect(key).toBe("telegram:123");
  });

  it("returns per-message key scoped to topic for forum groups", () => {
    const key = getTelegramSequentialKey(
      {
        message: {
          message_id: 55,
          date: 0,
          chat: { id: -100999, type: "supergroup", is_forum: true } as Chat,
          message_thread_id: 7,
          from: { id: 888, first_name: "Test", is_bot: false },
        } as Message,
      },
      {
        isRunActiveForChat: () => true,
      },
    );
    expect(key).toBe("telegram:-100999:topic:7:msg:55");
  });

  it("passes chatId, threadId, and senderId to the callback", () => {
    const spy = vi.fn().mockReturnValue(false);
    getTelegramSequentialKey(
      {
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 456, type: "supergroup", is_forum: true } as Chat,
          message_thread_id: 3,
          from: { id: 777, first_name: "Test", is_bot: false },
        } as Message,
      },
      { isRunActiveForChat: spy },
    );
    expect(spy).toHaveBeenCalledWith(456, 3, "777");
  });
});

describe("getTelegramSequentialKey — approval callback", () => {
  it("returns approval key for exec approval callback_query", () => {
    const key = getTelegramSequentialKey({
      update: {
        callback_query: {
          message: {
            message_id: 10,
            date: 0,
            chat: { id: 123, type: "private" } as Chat,
          } as Message,
          data: "/approve req-1 allow-once",
        },
      },
    });
    expect(key).toBe("telegram:123:approval");
  });

  it("returns default key for non-approval callback_query", () => {
    const key = getTelegramSequentialKey({
      update: {
        callback_query: {
          message: {
            message_id: 10,
            date: 0,
            chat: { id: 123, type: "private" } as Chat,
          } as Message,
          data: "some-other-callback",
        },
      },
    });
    expect(key).toBe("telegram:123");
  });

  it("returns fallback approval key when chatId is missing", () => {
    const key = getTelegramSequentialKey({
      update: {
        callback_query: {
          message: { message_id: 10, date: 0, chat: {} } as unknown as Message,
          data: "/approve req-1 allow-once",
        },
      },
    });
    expect(key).toBe("telegram:approval");
  });
});

describe("buildChatSessionCacheKey", () => {
  it("builds key from chatId only", () => {
    expect(buildChatSessionCacheKey(123, undefined)).toBe("123");
  });

  it("includes threadId when present", () => {
    expect(buildChatSessionCacheKey(123, 7)).toBe("123:7");
  });

  it("includes senderId when present", () => {
    expect(buildChatSessionCacheKey(123, undefined, "999")).toBe("123:999");
  });

  it("includes all three components", () => {
    expect(buildChatSessionCacheKey(123, 7, "999")).toBe("123:7:999");
  });

  it("handles string chatId", () => {
    expect(buildChatSessionCacheKey("abc", 5, "sender")).toBe("abc:5:sender");
  });
});
