// Telegram tests cover canonical thread-scope resolution and encoding.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { buildTelegramThreadParams, resolveTelegramMessageThreadSpec } from "./bot/helpers.js";

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
