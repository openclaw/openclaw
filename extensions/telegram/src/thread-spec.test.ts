// Telegram tests cover canonical thread-scope resolution and encoding.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramThreadParams,
  resolveTelegramMessageThreadSpec,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import { adoptTelegramDmTopicMessage, createTelegramDmTopicAdoptState } from "./dm-topic-adopt.js";

describe("resolveTelegramMessageThreadSpec client-created DM topics", () => {
  const chat = { id: 1001, type: "private" };
  const from = { id: 1001, is_bot: false, first_name: "User" };
  const topicCreated = {
    message_id: 500,
    date: 1_760_000_000,
    chat,
    from,
    message_thread_id: 500,
    is_topic_message: true,
    forum_topic_created: { name: "hello", icon_color: 0, is_name_implicit: true },
  } as unknown as Message;
  const rootMessage = () =>
    ({ message_id: 501, date: 1_760_000_000, chat, from, text: "hello" }) as unknown as Message;

  it("routes the root message the receiving account adopted into that topic", () => {
    const state = createTelegramDmTopicAdoptState();
    const message = rootMessage();
    expect(resolveTelegramMessageThreadSpec(topicCreated)).toEqual({ id: 500, scope: "dm" });
    adoptTelegramDmTopicMessage(topicCreated, state);
    expect(adoptTelegramDmTopicMessage(message, state)).toBe(500);
    expect(resolveTelegramMessageThreadSpec(message)).toEqual({ id: 500, scope: "dm" });
    expect(resolveTelegramMessageThreadSpec(message)).toEqual({ id: 500, scope: "dm" });
    // A later root message is a genuine root message again.
    const next = { ...rootMessage(), message_id: 502 } as Message;
    expect(adoptTelegramDmTopicMessage(next, state)).toBeUndefined();
    expect(resolveTelegramMessageThreadSpec(next)).toEqual({ scope: "dm" });
  });

  it("keeps the adopted topic on normalized message copies but not in serialized JSON", () => {
    const state = createTelegramDmTopicAdoptState();
    adoptTelegramDmTopicMessage(topicCreated, state);
    const message = rootMessage();
    expect(adoptTelegramDmTopicMessage(message, state)).toBe(500);
    // Inbound normalization spreads a private message without `is_forum` into a copy.
    const normalized = withResolvedTelegramForumFlag(message, false);
    expect(normalized).not.toBe(message);
    expect(resolveTelegramMessageThreadSpec(normalized)).toEqual({ id: 500, scope: "dm" });
    // Durable rows carry the fact as explicit payload metadata, never as message state.
    expect(JSON.stringify(message)).toBe(JSON.stringify(rootMessage()));
    expect(resolveTelegramMessageThreadSpec(structuredClone(message))).toEqual({ scope: "dm" });
  });

  it("keeps a root DM message that no account adopted in the root session", () => {
    expect(resolveTelegramMessageThreadSpec(rootMessage())).toEqual({ scope: "dm" });
  });
});

describe("resolveTelegramMessageThreadSpec", () => {
  it.each([
    {
      name: "bot-private topic",
      message: { chat: { id: 123, type: "private" }, message_thread_id: 42 },
      expected: { id: 42, scope: "dm" },
    },
    {
      name: "forum topic from message hint",
      message: {
        chat: { id: -100123, type: "supergroup" },
        is_topic_message: true,
        message_thread_id: 99,
      },
      expected: { id: 99, scope: "forum" },
    },
    {
      name: "forum General topic",
      message: { chat: { id: -100123, type: "supergroup", is_forum: true } },
      expected: { id: 1, scope: "forum" },
    },
    {
      name: "channel Direct Messages topic",
      message: {
        chat: { id: -100123, type: "supergroup", is_direct_messages: true },
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
      },
      expected: { id: 77, scope: "direct-messages" },
    },
    {
      name: "invalid channel Direct Messages evidence",
      message: {
        chat: { id: -100123, type: "supergroup", is_direct_messages: true },
        direct_messages_topic: { topic_id: 0 },
        message_thread_id: 77,
      },
      expected: { scope: "none" },
    },
    {
      name: "regular group without topic proof",
      message: { chat: { id: -100123, type: "supergroup" }, message_thread_id: 42 },
      expected: { scope: "none" },
    },
  ])("resolves $name", ({ message, expected }) => {
    expect(resolveTelegramMessageThreadSpec(message as Message)).toEqual(expected);
  });
});

describe("buildTelegramThreadParams", () => {
  it.each([
    { input: { id: 1, scope: "forum" as const }, expected: undefined },
    { input: { id: 99, scope: "forum" as const }, expected: { message_thread_id: 99 } },
    { input: { id: 2, scope: "dm" as const }, expected: { message_thread_id: 2 } },
    {
      input: { id: 77, scope: "direct-messages" as const },
      expected: { direct_messages_topic_id: 77 },
    },
    { input: { id: -1, scope: "direct-messages" as const }, expected: undefined },
    { input: { id: 42.9, scope: "forum" as const }, expected: { message_thread_id: 42 } },
  ])("builds thread params", ({ input, expected }) => {
    expect(buildTelegramThreadParams(input)).toEqual(expected);
  });
});
