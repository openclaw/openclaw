import type { Message } from "grammy/types";
import { afterEach, beforeEach, expect, it } from "vitest";
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

let cache: TelegramMessageCache;
function record(msg: Message) {
  return cache.record({ accountId: "default", chatId: msg.chat.id, msg });
}

function conversation(
  messageId: string,
  options: Partial<Parameters<typeof buildTelegramConversationContext>[0]> = {},
) {
  return buildTelegramConversationContext({
    cache,
    accountId: "default",
    chatId: 7,
    messageId,
    replyChainNodes: [],
    recentLimit: 10,
    replyTargetWindowSize: 1,
    ...options,
  });
}

beforeEach(() => {
  clearTelegramRuntimeForTest();
  resetTelegramMessageCacheForTest();
  cache = createTelegramMessageCache();
});
afterEach(resetTelegramMessageCacheForTest);

it.each([
  [undefined, "[unsupported Telegram rich_message received]"],
  ["Forwarded cache text", "Forwarded cache text"],
])("preserves rich messages (text=%s) in subsequent context", async (text, body) => {
  const block = { type: "paragraph", text };
  const chat = { id: 7, type: "private", first_name: "Nora" } as const;
  await record(message(45, { chat, text: undefined, rich_message: { blocks: [block] } }));
  await record(message(46, { chat, text: "What did I just send?" }));
  expect(await conversation("46", { replyTargetWindowSize: 2 })).toMatchObject([
    { node: { messageId: "45", body } },
  ]);
});

it("selects reply targets referenced by the current local window", async () => {
  for (const id of [33867, 33868, 33869]) {
    await record(message(id));
  }
  for (let id = 34460; id <= 34475; id++) {
    await record(message(id));
  }
  await record(message(34476, { reply_to_message: message(33868) }));
  await record(message(34477));
  const context = await conversation("34477");
  expect(context.map((entry) => entry.node.messageId)).toEqual(
    "33867 33868 33869 34467 34468 34469 34470 34471 34472 34473 34474 34475 34476".split(" "),
  );
  expect(context.find((entry) => entry.node.messageId === "33868")?.isReplyTarget).toBe(true);
});

it("does not select messages before the persisted session start when the reset command is absent", async () => {
  const chat = { id: -7, type: "supergroup", title: "Ops", is_forum: true } as const;
  const topicMessage = (id: number, date: number) =>
    message(id, { chat, message_thread_id: 9, date });
  const stale = topicMessage(2, 1_000);
  for (const msg of [topicMessage(1, 700), stale, topicMessage(3, 3_000)]) {
    await record(msg);
  }
  const current = message(4, { chat, message_thread_id: 9, date: 10_200, reply_to_message: stale });
  await record(current);
  const replyChainNodes = await buildTelegramReplyChain({
    cache,
    accountId: "default",
    chatId: chat.id,
    msg: current,
  });
  const context = await conversation("4", {
    chatId: chat.id,
    threadId: 9,
    replyChainNodes,
    minTimestampMs: 2_000_127,
  });
  expect(context.map((entry) => entry.node.messageId)).toEqual(["3"]);
});
