import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
} from "./runtime.test-support.js";

let cfg: OpenClawConfig;
let testState: OpenClawTestState;

async function recordAndRead(
  params: Omit<Parameters<typeof recordOutboundMessageForPromptContext>[0], "cfg">,
) {
  await recordOutboundMessageForPromptContext({ cfg, ...params });
  const cache = createPromptContextCache();
  return await cache.get({
    accountId: params.account.accountId,
    chatId: params.chatId,
    messageId: String(params.messageId),
  });
}

function createPromptContextCache() {
  return createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(resolveStorePath(cfg.session?.store)),
  });
}

describe("recordOutboundMessageForPromptContext", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "telegram-outbound-history",
      layout: "state-only",
    });
    cfg = { session: { store: testState.statePath("sessions", "sessions.json") } };
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheBucketsForTest();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(async () => {
    clearTelegramRuntime();
    resetTelegramMessageCacheBucketsForTest();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  it("binds topics only when the successful provider response identifies the thread", async () => {
    const common = {
      account: { accountId: "default", name: "Configured Agent" },
      chatId: -1001,
      messageId: 700,
      text: "Bot just replied",
      messageThreadId: 77,
    } as const;
    const callerOnlyThread = await recordAndRead({
      ...common,
      successfulSendThread: { id: 77, scope: "forum" },
      message: {
        chat: { id: -1001, type: "supergroup", title: "QA" },
        date: 1_736_380_700,
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        message_id: 700,
        text: "Bot just replied",
      },
    });
    expect(hasProviderObservedTelegramThreadBinding(callerOnlyThread, 77)).toBe(false);

    const providerThread = await recordAndRead({
      ...common,
      messageId: 701,
      successfulSendThread: { id: 77, scope: "forum" },
      message: {
        chat: { id: -1001, type: "supergroup", title: "QA" },
        date: 1_736_380_701,
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        message_id: 701,
        message_thread_id: 77,
        text: "Bot replied in the topic",
      },
    });
    expect(hasProviderObservedTelegramThreadBinding(providerThread, 77)).toBe(true);
  });

  it("retains forum and channel Direct Messages thread provenance without exposing topicless history", async () => {
    const chatId = -1001;
    for (const { scope, messageId, body } of [
      { scope: "forum", messageId: 710, body: "Forum reply" },
      { scope: "direct-messages", messageId: 711, body: "Direct-topic reply" },
    ] as const) {
      await recordOutboundMessageForPromptContext({
        cfg,
        account: { accountId: "default", name: "Configured Agent" },
        chatId,
        messageId,
        messageThreadId: 77,
        successfulSendThread: { scope, id: 77 },
        message: {
          chat: { id: chatId, type: "supergroup" },
          date: 1_736_380_700,
          message_id: messageId,
          ...(scope === "forum"
            ? { message_thread_id: 77 }
            : { direct_messages_topic: { topic_id: 77 } }),
          text: body,
        },
      });
    }

    resetTelegramMessageCacheBucketsForTest();
    const cache = createPromptContextCache();
    const history = await cache.readHistory({
      accountId: "default",
      chatId,
      threadId: 77,
      limit: 10,
    });
    expect(history.messages).toMatchObject([
      {
        messageId: "710",
        body: "Forum reply",
        sender: "Configured Agent (you)",
        threadBinding: { threadSpec: { scope: "forum", id: 77 } },
      },
      {
        messageId: "711",
        body: "Direct-topic reply",
        sender: "Configured Agent (you)",
        threadBinding: { threadSpec: { scope: "direct-messages", id: 77 } },
      },
    ]);
    expect(await cache.readHistory({ accountId: "default", chatId, limit: 10 })).toEqual({
      messages: [],
      hasMore: false,
    });
  });

  it("does not infer a General-topic binding for DM thread context", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "Configured Agent" },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        message_id: 703,
        text: "Bot replied in a DM topic",
      },
      messageId: 703,
      messageThreadId: 1,
      successfulSendThread: { id: 1, scope: "dm" },
    });

    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(false);
  });

  it("falls back to the Telegram bot name when no configured name exists", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "" },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Atlas",
          username: "atlas_bot",
        },
        message_id: 701,
        text: "Bot just replied",
      },
      messageId: 701,
      text: "Bot just replied",
    });

    expect(cached).toMatchObject({
      sender: "Atlas (you)",
      senderId: "999",
      senderUsername: "atlas_bot",
    });
  });

  it("uses the synthetic sender identity for a finalized streamed message without from", async () => {
    const initial = await recordAndRead({
      account: { accountId: "default", name: "StreamBot" },
      chatId: 42,
      message: { message_id: 1497 },
      messageId: 1497,
      text: "Final streamed reply",
    });

    expect(initial).toMatchObject({
      sender: "StreamBot (you)",
      senderId: "0",
      sourceMessage: {
        from: {
          id: 0,
          is_bot: true,
          first_name: "StreamBot (you)",
        },
      },
    });
  });

  it("ignores Telegram's fake sender identity across channel post echoes", async () => {
    const initial = await recordAndRead({
      account: { accountId: "default" },
      chatId: -1001,
      message: {
        message_id: 1498,
        from: { id: 777_000, is_bot: false, first_name: "Telegram" },
        sender_chat: { id: -1001, title: "Announcements" },
      },
      messageId: 1498,
      text: "Channel announcement",
    });
    expect(initial).toMatchObject({ sender: "OpenClaw (you)", senderId: "0" });

    const cache = createPromptContextCache();
    await cache.record({
      accountId: "default",
      chatId: -1001,
      msg: {
        message_id: 1498,
        date: 1_736_380_900,
        chat: { id: -1001, type: "supergroup", title: "Announcements" },
        from: { id: 777_000, is_bot: false, first_name: "Telegram" },
        sender_chat: { id: -1001, type: "channel", title: "Announcements" },
        text: "Channel announcement",
      },
    });

    const merged = await cache.get({
      accountId: "default",
      chatId: -1001,
      messageId: "1498",
    });
    expect(merged).toMatchObject({
      sender: "OpenClaw (you)",
      senderId: "0",
      sourceMessage: {
        from: { id: 0, is_bot: true, first_name: "OpenClaw (you)" },
        sender_chat: { id: -1001, type: "channel", title: "Announcements" },
      },
    });
  });
});
