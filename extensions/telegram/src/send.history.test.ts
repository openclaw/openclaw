import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import {
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
  makeTelegramApiTestMock,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi } = getTelegramSendTestMocks();
const { editMessageTelegram, sendLocationTelegram, sendMessageTelegram } =
  await importTelegramSendModule();
const TELEGRAM_TEST_CFG = {};

beforeEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
  resetTelegramMessageCacheBucketsForTest();
  resetTelegramSentMessageCacheForTest();
  setTelegramPluginStateRuntimeForTests();
});

afterEach(async () => {
  resetTelegramSentMessageCacheForTest();
  clearTelegramRuntime();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetTelegramMessageCacheBucketsForTest();
  vi.restoreAllMocks();
});

describe("Telegram sent message history", () => {
  it.each([
    { name: "group text", kind: "text", chatId: "-100123", chatType: "supergroup" },
    { name: "group location", kind: "location", chatId: "-100123", chatType: "supergroup" },
    { name: "direct text", kind: "text", chatId: "123", chatType: "private" },
  ] as const)(
    "preserves provider acceptance when $name history storage fails",
    async (testCase) => {
      const failure = new Error("history storage unavailable");
      const runtime = getTelegramRuntime();
      const openKeyedStore = runtime.state.openKeyedStore;
      vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
        if (options.namespace === TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE) {
          throw failure;
        }
        return openKeyedStore(options);
      });
      const location = { latitude: 48.858844, longitude: 2.294351 };
      const providerSend = testCase.kind === "text" ? botApi.sendMessage : vi.fn();
      providerSend.mockResolvedValue({
        message_id: 1499,
        date: 1_779_394_746,
        chat: { id: testCase.chatId, type: testCase.chatType },
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        ...(testCase.kind === "location" ? { location } : { text: "Delivered answer" }),
      });
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "assistant-history-failure",
      });
      const opts = {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api:
          testCase.kind === "location"
            ? makeTelegramApiTestMock({ sendLocation: providerSend })
            : undefined,
        promptContextProjectionPlan: { cursor, finalPart: true },
      };
      const delivery =
        testCase.kind === "location"
          ? sendLocationTelegram(testCase.chatId, location, opts)
          : sendMessageTelegram(testCase.chatId, "Delivered answer", opts);
      if (testCase.chatType === "private") {
        await expect(delivery).resolves.toMatchObject({ messageId: "1499", chatId: "123" });
      } else {
        let observed: unknown;
        try {
          await delivery;
        } catch (error) {
          observed = error;
        }
        expect(isChannelPartialDeliveryError(observed)).toBe(true);
        if (!(observed instanceof Error) || !isChannelPartialDeliveryError(observed)) {
          throw observed;
        }
        expect(observed.message).toContain(failure.message);
        expect(observed.deliveryResult).toMatchObject({
          messageIds: ["1499"],
          visibleReplySent: true,
        });
        expect(cursor.take(true).finalPart).toBe(false);
      }
      expect(providerSend).toHaveBeenCalledTimes(1);
    },
  );

  it("records a successful General-topic send when the response omits the thread id", async () => {
    const storePath = `/tmp/openclaw-telegram-general-context-${process.pid}-${Date.now()}.json`;
    const chatId = "-1003966283270";
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1498,
      date: 1_779_394_741,
      chat: { id: chatId, type: "supergroup", title: "QA forum" },
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "Reply in General",
    });

    await sendMessageTelegram(`${chatId}:topic:1`, "Reply in General", {
      cfg: { session: { store: storePath } },
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("message_thread_id");
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({
      accountId: "default",
      chatId,
      messageId: "1498",
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(true);
  });

  it.each(["text", "location"] as const)(
    "records transcript projection metadata for sent %s without replacing Telegram time",
    async (kind) => {
      const storePath = `/tmp/openclaw-telegram-send-projection-${process.pid}-${kind}.json`;
      const cfg = { session: { store: storePath } };
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "assistant-final",
      });
      const location = { latitude: 48.858844, longitude: 2.294351 };
      const send = kind === "text" ? botApi.sendMessage : vi.fn();
      send.mockResolvedValueOnce({
        message_id: 1497,
        date: 1_779_394_745,
        chat: { id: "123", type: "private" },
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        ...(kind === "text" ? { text: "Final answer" } : { location }),
      });

      const opts = { cfg, token: "tok", promptContextProjectionPlan: { cursor, finalPart: true } };
      if (kind === "text") {
        await sendMessageTelegram("123", "Final answer", opts);
      } else {
        await sendLocationTelegram("123", location, {
          ...opts,
          api: makeTelegramApiTestMock({ sendLocation: send }),
        });
      }

      const cache = createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      });
      const node = await cache.get({
        accountId: "default",
        chatId: "123",
        messageId: "1497",
      });

      expect(node?.timestamp).toBe(1_779_394_745_000);
      expect(node?.promptContextProjectionMarker).toEqual({
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: true },
      });
      expect(cursor.nextPartIndex).toBe(1);
    },
  );
});

describe("Telegram edited message history", () => {
  it("refreshes cached captions from Telegram's authoritative edit response", async () => {
    const storePath = `/tmp/openclaw-telegram-edited-caption-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const chat = {
      id: -100123,
      type: "supergroup" as const,
      title: "Ops",
      is_forum: true as const,
    };
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      msg: {
        chat,
        message_id: 902,
        message_thread_id: 77,
        date: 1_779_394_740,
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        caption: "outdated content",
      },
    });
    const editedMessage = {
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      edit_date: 1_779_394_750,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      caption: "authoritative edited content",
    };
    botApi.editMessageCaption.mockResolvedValue(editedMessage);

    await editMessageTelegram(chat.id, 902, "authoritative edited content", {
      token: "42:test-token",
      cfg,
      editMode: "caption",
    });

    const cached = await cache.get({
      accountId: "default",
      chatId: chat.id,
      messageId: "902",
    });
    expect(cached?.body).toBe("authoritative edited content");
    expect(hasProviderObservedTelegramThreadBinding(cached, 77)).toBe(true);
  });

  it("refreshes edited group messages without duplicating self history or hiding later replies", async () => {
    const storePath = `/tmp/openclaw-telegram-edit-history-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const chat = { id: -100123, type: "supergroup" as const, title: "Ops" };
    botApi.sendMessage.mockResolvedValueOnce({
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "original response",
    });
    await sendMessageTelegram(String(chat.id), "original response", {
      token: "42:test-token",
      cfg,
      messageThreadId: 77,
    });
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    expect(
      await cache.readHistory({
        accountId: "default",
        chatId: chat.id,
        threadId: 77,
        limit: 50,
      }),
    ).toMatchObject({ messages: [{ messageId: "902", body: "original response" }] });
    await cache.record({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      historyEligible: true,
      msg: {
        chat,
        message_id: 903,
        message_thread_id: 77,
        date: 1_779_394_741,
        from: { id: 43, is_bot: false, first_name: "Teammate" },
        text: "context that must remain visible",
      },
    });
    botApi.editMessageText.mockResolvedValue({
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "authoritative edited response",
    });

    await editMessageTelegram(chat.id, 902, "authoritative edited response", {
      token: "42:test-token",
      cfg,
    });

    resetTelegramMessageCacheBucketsForTest();
    const reopened = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const history = await reopened.readHistory({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      limit: 50,
    });
    expect(history.messages).toMatchObject([
      {
        messageId: "902",
        sender: "OpenClaw (you)",
        body: "authoritative edited response",
        timestamp: 1_779_394_740_000,
      },
      {
        messageId: "903",
        sender: "Teammate",
        body: "context that must remain visible",
        timestamp: 1_779_394_741_000,
      },
    ]);
    expect(history.hasMore).toBe(false);
  });
});
