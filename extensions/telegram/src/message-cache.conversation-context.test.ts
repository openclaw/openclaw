import type { Message } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  type TelegramMessageCache,
} from "./message-cache.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

function message(messageId: number, fields: Record<string, unknown> = {}): Message {
  return {
    chat: { id: 7, type: "supergroup", title: "Ops" },
    message_id: messageId,
    date: 1736380000 + messageId,
    text: `message ${messageId}`,
    from: { id: 1, is_bot: false, first_name: "Participant" },
    ...fields,
  } as Message;
}

function record(cache: TelegramMessageCache, msg: Message) {
  return cache.record({ accountId: "default", chatId: msg.chat.id, msg });
}

describe("telegram message cache conversation context", () => {
  beforeEach(() => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
  });
  afterEach(() => {
    resetTelegramMessageCacheForTest();
  });

  it("returns recent chat messages before the current message", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [41, 42, 43, 44]) {
      await record(cache, message(id, { message_thread_id: 100 }));
    }
    await record(cache, message(142, { message_thread_id: 200 }));
    const recent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      threadId: 100,
      messageId: "44",
      limit: 2,
    });
    expect(recent.map((entry) => entry.messageId)).toEqual(["42", "43"]);
  });

  it.each([
    {
      name: "placeholder",
      block: { type: "paragraph" },
      body: "[unsupported Telegram rich_message received]",
    },
    {
      name: "text",
      block: { type: "paragraph", text: "Forwarded cache text" },
      body: "Forwarded cache text",
    },
  ])("preserves rich-message $name in subsequent conversation context", async ({ block, body }) => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "private", first_name: "Nora" } as const;
    await record(cache, message(45, { chat, text: undefined, rich_message: { blocks: [block] } }));
    await record(cache, message(46, { chat, text: "What did I just send?" }));
    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "46",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });
    expect(
      context.map((entry) => ({ messageId: entry.node.messageId, body: entry.node.body })),
    ).toEqual([{ messageId: "45", body }]);
  });

  it("selects reply targets referenced by the current local window", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [33867, 33868, 33869]) {
      await record(cache, message(id));
    }
    for (let id = 34460; id <= 34475; id++) {
      await record(cache, message(id));
    }
    await record(cache, message(34476, { reply_to_message: message(33868) }));
    await record(cache, message(34477));
    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "34477",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });
    expect(context.map((entry) => entry.node.messageId)).toEqual([
      "33867",
      "33868",
      "33869",
      "34467",
      "34468",
      "34469",
      "34470",
      "34471",
      "34472",
      "34473",
      "34474",
      "34475",
      "34476",
    ]);
    expect(context.find((entry) => entry.node.messageId === "33868")?.isReplyTarget).toBe(true);
  });

  it("does not select messages before the persisted session start when the reset command is absent", async () => {
    const cache = createTelegramMessageCache();
    const beforeSession = Date.parse("2026-05-10T12:40:00.000Z");
    const sessionStartedAt = Date.parse("2026-05-10T17:30:43.127Z");
    const afterSession = Date.parse("2026-05-11T23:36:00.000Z");
    const chat = { id: -1001234567890, type: "supergroup", title: "Ops", is_forum: true } as const;
    const topicMessage = (id: number, text: string, timestampMs: number) =>
      message(id, { chat, message_thread_id: 22534, text, date: Math.floor(timestampMs / 1000) });
    const stale = topicMessage(
      84670,
      "okay so we just flip in openclaw? if yes do it up",
      beforeSession,
    );
    await record(cache, topicMessage(84649, "tools.toolSearch: true", beforeSession - 5 * 60_000));
    await record(cache, stale);
    await record(cache, topicMessage(87184, "how does this determine stability?", afterSession));
    const current = message(87227, {
      ...topicMessage(87227, "what config change?", afterSession + 2 * 60 * 60_000),
      reply_to_message: stale,
    });
    await record(cache, current);
    const replyChainNodes = await buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: chat.id,
      msg: current,
    });
    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: chat.id,
      messageId: "87227",
      threadId: 22534,
      replyChainNodes,
      recentLimit: 10,
      replyTargetWindowSize: 1,
      minTimestampMs: sessionStartedAt,
    });
    expect(context.map((entry) => entry.node.messageId)).toEqual(["87184"]);
  });
});
