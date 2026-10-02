// Telegram tests cover sequential key plugin behavior.
import type { Chat, Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { getTelegramSequentialConstraints, getTelegramSequentialKey } from "./sequential-key.js";

const mockChat = (
  chat: Pick<Chat, "id"> & Partial<Pick<Chat, "type" | "is_forum" | "is_direct_messages">>,
): Chat => chat as Chat;
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
      "telegram:123",
    ],
    [
      {
        me: { has_topics_enabled: true } as never,
        message: mockMessage({
          chat: mockChat({ id: 123, type: "private" }),
          message_thread_id: 9,
        }),
      },
      "telegram:123:topic:9",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: mockMessage({
          chat: mockChat({ id: -100, type: "supergroup", is_forum: true }),
          is_topic_message: true,
          message_thread_id: 5907,
          text: "/stop@some_other_bot",
        }),
      },
      "telegram:-100:topic:5907",
    ],
    [
      {
        me: { username: "openclaw_bot" } as never,
        message: mockMessage({
          chat: mockChat({ id: -100, type: "supergroup", is_forum: true }),
          is_topic_message: true,
          message_thread_id: 5907,
          text: "/stop@openclaw_bot!",
        }),
      },
      "telegram:-100:control",
    ],
    // Interrupt commands keep the chat-wide control lane. `/approve` in particular must
    // never queue behind the run that is blocked waiting on its own approval request.
    [
      {
        message: mockMessage({
          chat: mockChat({ id: 123 }),
          text: "/approve exec:def456 allow-once",
        }),
      },
      "telegram:123:control",
    ],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: -100, type: "supergroup", is_forum: true }),
          is_topic_message: true,
          message_thread_id: 202,
          text: "/approve exec:def456 deny",
        }),
      },
      "telegram:-100:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/queue" }) },
      "telegram:123:control",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/steer do the thing" }) },
      "telegram:123:control",
    ],
    // Session-mutating commands must not share the chat-wide control lane: their writes
    // stay ordered behind their own topic's pending input, `activeRunSafe` notwithstanding.
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/new" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/new sync tars" }) },
      "telegram:123",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/reset" }) }, "telegram:123"],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/think high" }) },
      "telegram:123",
    ],
    [{ message: mockMessage({ chat: mockChat({ id: 123 }), text: "/compact" }) }, "telegram:123"],
    [
      {
        message: mockMessage({
          chat: mockChat({ id: -100, type: "supergroup", is_forum: true }),
          is_topic_message: true,
          message_thread_id: 202,
          text: "/new sync tars",
        }),
      },
      "telegram:-100:topic:202",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/diagnostics" }) },
      "telegram:123",
    ],
    [
      { message: mockMessage({ chat: mockChat({ id: 123 }), text: "/btw what is the time?" }) },
      "telegram:123:btw:1",
    ],
    ...(["exec", "plugin"] as const).map(
      (approvalKind): [Parameters<typeof getTelegramSequentialKey>[0], string] => [
        {
          update: {
            callback_query: {
              message: mockMessage({ chat: mockChat({ id: 654 }) }),
              data: buildTelegramApprovalCallbackData({
                type: "approval",
                approvalKind,
                approvalId: "signed-approval",
                decision: "allow-once",
              }),
            },
          },
        },
        "telegram:654:approval",
      ],
    ),
    [
      {
        update: {
          callback_query: {
            message: mockMessage({ chat: mockChat({ id: 321 }) }),
            data: "tgq1:ask_0123456789abcdef0123456789abcdef:2",
          },
        },
      },
      "telegram:321:question",
    ],
  ])("resolves key %#", (input, expected) => {
    expect(getTelegramSequentialKey(input)).toEqual(expected);
  });

  it("keeps malformed message updates on the unknown lane", () => {
    expect(getTelegramSequentialKey({ message: {} as Message })).toBe("telegram:unknown");
  });

  describe("forum flag cache fallback", () => {
    it("uses cached forum flag to assign topic:1 lane when payload lacks is_forum and is_topic_message", async () => {
      // Prime the cache the way bot-message-context does: resolveTelegramForumFlag
      // calls cacheTelegramForumFlag internally when the hint is available.
      await resolveTelegramForumFlag({
        chatId: -9001,
        chatType: "supergroup",
        isGroup: true,
        isForum: true,
      });

      // General topic message: no is_forum, no is_topic_message, no message_thread_id.
      // Without the cache, getTelegramSequentialKey returns the base lane.
      // With the cache primed, it must return topic:1.
      const generalTopicCtx = {
        message: mockMessage({
          chat: mockChat({ id: -9001, type: "supergroup" }),
        }),
      };
      expect(getTelegramSequentialKey(generalTopicCtx)).toBe("telegram:-9001:topic:1");
    });

    it("falls back to base lane when cache is empty and payload lacks is_forum hint", () => {
      const ctx = {
        message: mockMessage({
          chat: mockChat({ id: -9002, type: "supergroup" }),
        }),
      };
      expect(getTelegramSequentialKey(ctx)).toBe("telegram:-9002");
    });

    it("honors an explicit forum hint when the cached flag is stale", async () => {
      await resolveTelegramForumFlag({
        chatId: -9004,
        chatType: "supergroup",
        isGroup: true,
        isForum: false,
      });

      const ctx = {
        message: mockMessage({
          chat: mockChat({ id: -9004, type: "supergroup" }),
          is_topic_message: true,
        }),
      };
      expect(getTelegramSequentialKey(ctx)).toBe("telegram:-9004:topic:1");
    });
  });
});

describe("getTelegramSequentialConstraints", () => {
  it("bridges a forum message update with its reaction update", () => {
    const message = mockMessage({
      chat: mockChat({ id: -1001, type: "supergroup", is_forum: true }),
      message_id: 77,
      message_thread_id: 9,
      is_topic_message: true,
    });
    const expected = "telegram:-1001:message:77";
    const reaction = {
      update: {
        message_reaction: {
          chat: { id: -1001, type: "supergroup", is_forum: true },
          message_id: 77,
        },
      },
    };

    expect(getTelegramSequentialConstraints({ message })).toEqual([
      "telegram:-1001:topic:9",
      expected,
    ]);
    expect(getTelegramSequentialConstraints(reaction)).toBe(expected);
  });

  it("bridges a channel Direct Messages message with its reaction without coupling topics", () => {
    const message = mockMessage({
      chat: mockChat({
        id: -1002,
        type: "supergroup",
        is_direct_messages: true,
      } as Chat),
      message_id: 77,
      message_thread_id: 999,
      direct_messages_topic: { topic_id: 9, user: { id: 1 } as never },
      is_topic_message: true,
    });
    const expected = "telegram:-1002:message:77";
    const reaction = {
      update: {
        message_reaction: {
          chat: { id: -1002, type: "supergroup", is_direct_messages: true },
          message_id: 77,
        },
      },
    };

    expect(getTelegramSequentialConstraints({ message })).toEqual([
      "telegram:-1002:topic:9",
      expected,
    ]);
    expect(getTelegramSequentialConstraints(reaction)).toBe(expected);
    expect(
      getTelegramSequentialConstraints({
        update: {
          message_reaction: {
            chat: { id: -1002, type: "supergroup", is_direct_messages: true },
            message_id: 78,
          },
        },
      }),
    ).toBe("telegram:-1002:message:78");
  });

  it("does not add a bridge lane outside forum chats", () => {
    expect(
      getTelegramSequentialConstraints({
        message: mockMessage({ chat: mockChat({ id: 123, type: "private" }) }),
      }),
    ).toBe("telegram:123");
  });
});
