// Covers adopting a root DM message into the topic a client just created for it.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createTelegramDmTopicAdoptState,
  resolveAdoptedTelegramDmThreadId,
  TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC,
} from "./dm-topic-adopt.js";

const user = { id: 1001, is_bot: false, first_name: "User" };
const privateChat = { id: 1001, type: "private" as const, first_name: "User" };

function topicCreated(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 500,
    date: 1_760_000_000,
    chat: privateChat,
    from: user,
    message_thread_id: 500,
    is_topic_message: true,
    forum_topic_created: { name: "hello", icon_color: 0, is_name_implicit: true },
    ...overrides,
  } as Message;
}

function rootMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 501,
    date: 1_760_000_000,
    chat: privateChat,
    from: user,
    text: "hello",
    ...overrides,
  } as Message;
}

describe("resolveAdoptedTelegramDmThreadId", () => {
  it("adopts the next root message after a client-created topic", () => {
    const state = createTelegramDmTopicAdoptState();
    expect(resolveAdoptedTelegramDmThreadId(topicCreated(), state)).toBeUndefined();
    expect(resolveAdoptedTelegramDmThreadId(rootMessage(), state)).toBe(500);
  });

  it("keeps the adopted id stable across repeated resolution of the same message", () => {
    const state = createTelegramDmTopicAdoptState();
    resolveAdoptedTelegramDmThreadId(topicCreated(), state);
    expect(resolveAdoptedTelegramDmThreadId(rootMessage(), state)).toBe(500);
    expect(resolveAdoptedTelegramDmThreadId(rootMessage(), state)).toBe(500);
    // A later root message is a genuine root message again.
    expect(
      resolveAdoptedTelegramDmThreadId(rootMessage({ message_id: 502 }), state),
    ).toBeUndefined();
  });

  it("does not adopt when the first message arrives inside the topic", () => {
    const state = createTelegramDmTopicAdoptState();
    resolveAdoptedTelegramDmThreadId(topicCreated(), state);
    expect(
      resolveAdoptedTelegramDmThreadId(
        rootMessage({ message_thread_id: 500, is_topic_message: true }),
        state,
      ),
    ).toBeUndefined();
    expect(
      resolveAdoptedTelegramDmThreadId(rootMessage({ message_id: 502 }), state),
    ).toBeUndefined();
  });

  it("adopts within the window and ignores later root messages", () => {
    const state = createTelegramDmTopicAdoptState();
    resolveAdoptedTelegramDmThreadId(topicCreated(), state);
    expect(
      resolveAdoptedTelegramDmThreadId(
        rootMessage({ date: 1_760_000_000 + TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC + 1 }),
        state,
      ),
    ).toBeUndefined();
    expect(
      resolveAdoptedTelegramDmThreadId(
        rootMessage({ message_id: 502, date: 1_760_000_000 + TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC }),
        state,
      ),
    ).toBe(500);
  });

  it("ignores messages older than the topic creation", () => {
    const state = createTelegramDmTopicAdoptState();
    resolveAdoptedTelegramDmThreadId(topicCreated(), state);
    expect(resolveAdoptedTelegramDmThreadId(rootMessage({ message_id: 499 }), state)).toBe(
      undefined,
    );
    expect(
      resolveAdoptedTelegramDmThreadId(rootMessage({ date: 1_760_000_000 - 1 }), state),
    ).toBeUndefined();
  });

  it("ignores topics created by the bot or another user", () => {
    const state = createTelegramDmTopicAdoptState();
    resolveAdoptedTelegramDmThreadId(
      topicCreated({ from: { id: 42, is_bot: true, first_name: "Bot" } }),
      state,
    );
    expect(resolveAdoptedTelegramDmThreadId(rootMessage(), state)).toBeUndefined();

    resolveAdoptedTelegramDmThreadId(topicCreated(), state);
    expect(
      resolveAdoptedTelegramDmThreadId(
        rootMessage({ from: { id: 2002, is_bot: false, first_name: "Other" } }),
        state,
      ),
    ).toBeUndefined();
  });

  it("leaves group chats alone", () => {
    const state = createTelegramDmTopicAdoptState();
    const groupChat = {
      id: -100123,
      type: "supergroup" as const,
      title: "Group",
      is_forum: true as const,
    };
    resolveAdoptedTelegramDmThreadId(topicCreated({ chat: groupChat }), state);
    expect(resolveAdoptedTelegramDmThreadId(rootMessage({ chat: groupChat }), state)).toBe(
      undefined,
    );
    expect(state.pending.size).toBe(0);
  });

  it("bounds the pending and adopted caches", () => {
    const state = createTelegramDmTopicAdoptState();
    for (let i = 0; i < 600; i += 1) {
      const chat = { id: 10_000 + i, type: "private" as const, first_name: "U" };
      const from = { id: 10_000 + i, is_bot: false, first_name: "U" };
      resolveAdoptedTelegramDmThreadId(topicCreated({ chat, from }), state);
    }
    expect(state.pending.size).toBeLessThanOrEqual(512);
  });
});
