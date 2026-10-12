// Covers the edge cases of adopting a root DM message into the topic a client just created.
// The happy path lives at the resolver boundary (thread-spec.test.ts) and the ingress
// boundary (telegram-ingress-drain.test.ts).
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  adoptTelegramDmTopicMessage,
  createTelegramDmTopicAdoptState,
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

describe("adoptTelegramDmTopicMessage", () => {
  it("does not adopt when the first message arrives inside the topic", () => {
    const state = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(topicCreated(), state);
    expect(
      adoptTelegramDmTopicMessage(
        rootMessage({ message_thread_id: 500, is_topic_message: true }),
        state,
      ),
    ).toBeUndefined();
    expect(adoptTelegramDmTopicMessage(rootMessage({ message_id: 502 }), state)).toBeUndefined();
  });

  it("adopts within the window and ignores later root messages", () => {
    const state = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(topicCreated(), state);
    expect(
      adoptTelegramDmTopicMessage(
        rootMessage({ date: 1_760_000_000 + TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC + 1 }),
        state,
      ),
    ).toBeUndefined();
    expect(
      adoptTelegramDmTopicMessage(
        rootMessage({ message_id: 502, date: 1_760_000_000 + TELEGRAM_DM_TOPIC_ADOPT_WINDOW_SEC }),
        state,
      ),
    ).toBe(500);
  });

  it("ignores messages older than the topic creation", () => {
    const state = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(topicCreated(), state);
    expect(adoptTelegramDmTopicMessage(rootMessage({ message_id: 499 }), state)).toBeUndefined();
    expect(
      adoptTelegramDmTopicMessage(rootMessage({ date: 1_760_000_000 - 1 }), state),
    ).toBeUndefined();
  });

  it("ignores topics created by the bot or another user", () => {
    const state = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(
      topicCreated({ from: { id: 42, is_bot: true, first_name: "Bot" } }),
      state,
    );
    expect(adoptTelegramDmTopicMessage(rootMessage(), state)).toBeUndefined();

    adoptTelegramDmTopicMessage(topicCreated(), state);
    expect(
      adoptTelegramDmTopicMessage(
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
    adoptTelegramDmTopicMessage(topicCreated({ chat: groupChat }), state);
    expect(adoptTelegramDmTopicMessage(rootMessage({ chat: groupChat }), state)).toBeUndefined();
    expect(state.pending.size).toBe(0);
  });

  it("does not rearm the window when the consumed service message is resolved again", () => {
    const state = createTelegramDmTopicAdoptState();
    const created = topicCreated();
    adoptTelegramDmTopicMessage(created, state);
    expect(adoptTelegramDmTopicMessage(rootMessage(), state)).toBe(500);
    // Drain inspection resolves the same service update again.
    adoptTelegramDmTopicMessage(created, state);
    adoptTelegramDmTopicMessage(topicCreated(), state);
    expect(state.pending.size).toBe(0);
    expect(adoptTelegramDmTopicMessage(rootMessage({ message_id: 502 }), state)).toBeUndefined();
  });

  it("keeps adoption state per bot account", () => {
    const botA = createTelegramDmTopicAdoptState();
    const botB = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(topicCreated(), botA);
    // The same user's root message to another bot never consumes bot A's topic.
    expect(adoptTelegramDmTopicMessage(rootMessage(), botB)).toBeUndefined();
    expect(adoptTelegramDmTopicMessage(rootMessage(), botA)).toBe(500);
  });

  it("bounds the pending and consumed caches", () => {
    const state = createTelegramDmTopicAdoptState();
    for (let i = 0; i < 600; i += 1) {
      const chat = { id: 10_000 + i, type: "private" as const, first_name: "U" };
      const from = { id: 10_000 + i, is_bot: false, first_name: "U" };
      adoptTelegramDmTopicMessage(topicCreated({ chat, from }), state);
      adoptTelegramDmTopicMessage(rootMessage({ chat, from }), state);
    }
    expect(state.pending.size).toBe(0);
    expect(state.consumed.size).toBeLessThanOrEqual(512);
  });
});
