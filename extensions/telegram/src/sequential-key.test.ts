import type { Chat, Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { getTelegramSequentialConstraints, getTelegramSequentialKey } from "./sequential-key.js";

const mockMessage = (message: Partial<Message> = {}): Message =>
  ({
    message_id: 1,
    date: 0,
    chat: { id: 123, type: "private" },
    ...message,
  }) as Message;
const messageContext = (message: Partial<Message> = {}) => ({ message: mockMessage(message) });
const forumMessage = (text: string) =>
  mockMessage({
    chat: { id: -100, type: "supergroup", is_forum: true, title: "Forum" },
    is_topic_message: true,
    message_thread_id: 5907,
    text,
  });
const groupMessage = (id: number, extra: Partial<Message> = {}) =>
  mockMessage({ chat: { id, type: "supergroup", title: "Group" }, ...extra });
const callback = (id: number, data: string) => ({
  update: { callback_query: { message: groupMessage(id), data } },
});

const addressed = (text: string) => ({
  me: { username: "openclaw_bot" } as never,
  message: forumMessage(text),
});

describe("getTelegramSequentialKey", () => {
  it.each([
    [
      {
        me: { has_topics_enabled: true } as never,
        ...messageContext({ message_thread_id: 9 }),
      },
      "telegram:123:topic:9",
    ],
    [addressed("/stop@some_other_bot"), "telegram:-100:topic:5907"],
    [addressed("/stop@openclaw_bot!"), "telegram:-100:control"],
    // Approval cannot queue behind the run waiting on it.
    [messageContext({ text: "/approve exec:def456 allow-once" }), "telegram:123:control"],
    [{ message: forumMessage("/new sync tars") }, "telegram:-100:topic:5907"],
    [messageContext({ text: "/btw what is the time?" }), "telegram:123:btw:1"],
    [callback(654, "tga1:p:o:signed-approval"), "telegram:654:approval"],
    [callback(321, "tgq1:ask_0123456789abcdef0123456789abcdef:2"), "telegram:321:question"],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toEqual(expected);
  });

  it("keeps malformed message updates on the unknown lane", () => {
    expect(getTelegramSequentialKey({ message: {} as Message })).toBe("telegram:unknown");
  });

  it.each([
    { chatId: -9001, cached: true, hinted: undefined, expected: "telegram:-9001:topic:1" },
    { chatId: -9002, cached: undefined, hinted: undefined, expected: "telegram:-9002" },
    { chatId: -9004, cached: false, hinted: true, expected: "telegram:-9004:topic:1" },
  ])(
    "uses forum cache=$cached and hint=$hinted for $chatId",
    async ({ chatId, cached, hinted, expected }) => {
      if (cached !== undefined) {
        await resolveTelegramForumFlag({
          chatId,
          chatType: "supergroup",
          isGroup: true,
          isForum: cached,
        });
      }
      const message = groupMessage(
        chatId,
        hinted === undefined ? {} : { is_topic_message: hinted },
      );
      expect(getTelegramSequentialKey({ message })).toBe(expected);
    },
  );
});

describe("getTelegramSequentialConstraints", () => {
  it("bridges a channel Direct Messages message with its reaction without coupling topics", () => {
    const message = mockMessage({
      chat: {
        id: -1002,
        type: "supergroup",
        is_direct_messages: true,
        title: "Direct Messages",
      } as Chat,
      message_id: 77,
      message_thread_id: 999,
      direct_messages_topic: { topic_id: 9, user: { id: 1 } as never },
      is_topic_message: true,
    });
    const expected = "telegram:-1002:message:77";
    const reaction = (message_id: number) => ({
      update: {
        message_reaction: {
          chat: { id: -1002, type: "supergroup", is_direct_messages: true },
          message_id,
        },
      },
    });

    expect(getTelegramSequentialConstraints({ message })).toEqual([
      "telegram:-1002:topic:9",
      expected,
    ]);
    expect(getTelegramSequentialConstraints(reaction(77))).toBe(expected);
    expect(getTelegramSequentialConstraints(reaction(78))).toBe("telegram:-1002:message:78");
  });

  it("does not add a bridge lane outside forum chats", () => {
    expect(getTelegramSequentialConstraints(messageContext())).toBe("telegram:123");
  });
});
