import { describe, expect, it } from "vitest";
import { getTelegramSequentialKey } from "./sequential-key.js";
const mockChat = (chat) => chat;
const mockMessage = (message) => ({
  message_id: 1,
  date: 0,
  ...message
});
describe("getTelegramSequentialKey", () => {
  it.each([
    [{ message: mockMessage({ chat: mockChat({ id: 123 }) }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9
        })
      },
      "telegram:123:topic:9"
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup" }),
          message_thread_id: 9
        })
      },
      "telegram:123"
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123, type: "supergroup", is_forum: true })
        })
      },
      "telegram:123:topic:1"
    ],
    [{ update: { message: mockMessage({ chat: mockChat({ id: 555 }) }) } }, "telegram:555"],
    [
      {
        channelPost: mockMessage({ chat: mockChat({ id: -100777111222, type: "channel" }) })
      },
      "telegram:-100777111222"
    ],
    [
      {
        update: {
          channel_post: mockMessage({ chat: mockChat({ id: -100777111223, type: "channel" }) })
        }
      },
      "telegram:-100777111223"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/stop" }) },
      "telegram:123:control"
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/status" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1"
    ],
    [
      {
        me: { username: "openclaw_bot" },
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/btw@openclaw_bot what is the time?"
        })
      },
      "telegram:123:btw:1"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop" }) },
      "telegram:123:control"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "stop please" }) },
      "telegram:123:control"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "do not do that" }) },
      "telegram:123:control"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0441\u044C" }) },
      "telegram:123:control"
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "halt" }) },
      "telegram:123:control"
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort" }) }, "telegram:123"],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/abort now" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "please do not do that" }) },
      "telegram:123"
    ]
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toBe(expected);
  });
});
