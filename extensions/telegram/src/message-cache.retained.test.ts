import type { Message } from "grammy/types";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PersistedTelegramMessageCacheValue,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import {
  buildTelegramReplyChain,
  createTelegramMessageCache,
  type TelegramMessageCache,
} from "./message-cache.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const chatId = -1007;
const accountId = "default";
const scope = "retained-cache-test";
const scopeKey = resolveTelegramMessageCachePersistentScopeKey(scope);
const keyPrefix = `${scopeKey}:${accountId}:${chatId}:`;
const chat = { id: chatId, type: "supergroup" as const, title: "History" };

function message(messageId: number, fields: Record<string, unknown> = {}): Message {
  return {
    message_id: messageId,
    date: 1_736_371_600 + messageId,
    chat,
    from: { id: 42, is_bot: false, first_name: "Ada" },
    ...(fields.photo === undefined ? { text: `Message ${messageId}` } : {}),
    ...fields,
  } as Message;
}

function photo(fileId: string) {
  return [{ file_id: fileId, file_unique_id: `${fileId}-unique`, width: 640, height: 480 }];
}

const media = {
  id: "saved-photo.png",
  fileUniqueId: "photo-1-unique",
  size: 4,
  savedAt: 1_736_380_700_000,
  kind: "image" as const,
  path: "/private/photos/image.png",
  fileName: "private-name.png",
};

function record(cache: TelegramMessageCache, msg: Message, historyEligible = true) {
  return cache.record({ accountId, chatId, msg, historyEligible });
}

function history(
  cache: TelegramMessageCache,
  options: Partial<Parameters<TelegramMessageCache["readHistory"]>[0]> = {},
) {
  return cache.readHistory({ accountId, chatId, limit: 10, ...options });
}

function get(cache: TelegramMessageCache, messageId: number) {
  return cache.get({ accountId, chatId, messageId: String(messageId) });
}

describe("Telegram retained message history", () => {
  let state: OpenClawTestState;
  let beforeCompare: ((key: string) => Promise<void>) | undefined;
  let beforeMove: (() => Promise<void>) | undefined;
  let afterMove: (() => Promise<void>) | undefined;

  function openStores() {
    return {
      bounded: createPluginStateKeyedStoreForTests<unknown>("telegram", {
        namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
        maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
        env: state.env,
      }),
      retained: createPluginStateKeyedStoreForTests<PersistedTelegramMessageCacheValue>(
        "telegram",
        {
          namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
          retention: "retained",
          env: state.env,
        },
      ),
    };
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "telegram-history-", layout: "state-only" });
    beforeCompare = undefined;
    beforeMove = undefined;
    afterMove = undefined;
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ): PluginStateKeyedStore<T> => {
      const store = createPluginStateKeyedStoreForTests<T>("telegram", {
        ...options,
        env: state.env,
      });
      if (options.retention !== "retained") {
        return store;
      }
      return {
        ...store,
        async compareAndApply(key, comparison, intent) {
          const interrupt = beforeCompare;
          beforeCompare = undefined;
          await interrupt?.(key);
          return store.compareAndApply(key, comparison, intent);
        },
        async moveEntriesFrom(source) {
          await beforeMove?.();
          const moved = await store.moveEntriesFrom(source);
          const interrupt = afterMove;
          afterMove = undefined;
          await interrupt?.();
          return moved;
        },
      };
    };
    setTelegramRuntime(createPluginRuntimeMock({ state: { openKeyedStore } }));
  });

  afterEach(async () => {
    resetTelegramMessageCacheForTest();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  function seedFullLegacyNamespace() {
    const stores = openStores();
    const otherScope = "retained-cache-other";
    const otherPrefix = `${resolveTelegramMessageCachePersistentScopeKey(otherScope)}:${accountId}:${chatId}:`;
    const privateChat = { id: 7, type: "private", first_name: "Ada" };
    importPluginStateEntriesForDoctorForTests(
      "telegram",
      {
        namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
        maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
        env: state.env,
      },
      [
        { key: `${keyPrefix}1`, value: { version: 1, sourceMessage: message(1) }, createdAt: 1000 },
        {
          key: `${otherPrefix}2`,
          value: { version: 1, sourceMessage: message(2) },
          createdAt: 2000,
        },
        ...Array.from(
          { length: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES - 2 },
          (_, index) => ({
            key: `${scopeKey}:${accountId}:7:${100 + index}`,
            value: {
              version: 1,
              sourceMessage: message(100 + index, {
                chat: privateChat,
                ...(index === 0 ? { photo: photo("photo-1") } : {}),
              }),
            },
            createdAt: 3000 + index,
          }),
        ),
      ],
    );
    return { ...stores, otherScope, otherPrefix, privateChat };
  }

  it.each(["record", "media"] as const)(
    "promotes legacy groups from every scope before the first bounded %s write",
    async (writer) => {
      const { bounded, retained, otherScope, otherPrefix, privateChat } = seedFullLegacyNamespace();
      const cache = createTelegramMessageCache({ scope });
      if (writer === "record") {
        await cache.record({
          accountId,
          chatId: 7,
          msg: message(5000, { chat: privateChat, text: "First DM after upgrade" }),
        });
        expect(await bounded.lookup(`${scopeKey}:${accountId}:7:5000`)).toMatchObject({
          sourceMessage: { text: "First DM after upgrade" },
        });
      } else {
        await cache.recordResolvedMedia({ accountId, chatId: 7, messageId: "100", media });
        expect(await bounded.lookup(`${scopeKey}:${accountId}:7:100`)).toMatchObject({
          resolvedMedia: { id: media.id },
        });
      }
      expect(await bounded.lookup(`${keyPrefix}1`)).toBeUndefined();
      expect(await bounded.lookup(`${otherPrefix}2`)).toBeUndefined();
      expect(await retained.count()).toBe(2);
      resetTelegramMessageCacheForTest();
      expect(await get(createTelegramMessageCache({ scope }), 1)).toMatchObject({
        body: "Message 1",
      });
      expect(await get(createTelegramMessageCache({ scope: otherScope }), 2)).toMatchObject({
        body: "Message 2",
      });
    },
  );

  it("keeps failed promotion nonfatal for ordinary DMs without allowing bounded writes to evict history", async () => {
    const { bounded, retained, otherPrefix, privateChat } = seedFullLegacyNamespace();
    const originalMediaRow = await bounded.lookup(`${scopeKey}:${accountId}:7:100`);
    beforeMove = async () => {
      throw new Error("promotion unavailable");
    };
    const cache = createTelegramMessageCache({ scope });
    await expect(
      cache.record({
        accountId,
        chatId: 7,
        msg: message(5000, { chat: privateChat, text: "Memory-only DM" }),
      }),
    ).resolves.toMatchObject({ body: "Memory-only DM" });
    await cache.recordResolvedMedia({ accountId, chatId: 7, messageId: "100", media });
    expect(await cache.get({ accountId, chatId: 7, messageId: "100" })).toMatchObject({
      resolvedMedia: { id: media.id },
    });
    expect(await bounded.lookup(`${scopeKey}:${accountId}:7:5000`)).toBeUndefined();
    expect(await bounded.lookup(`${scopeKey}:${accountId}:7:100`)).toEqual(originalMediaRow);
    await expect(
      cache.record({
        accountId,
        chatId: 7,
        msg: message(5001, {
          chat: privateChat,
          from: { id: 42, is_bot: true, first_name: "Bot" },
        }),
        botUserId: 42,
        promptContextProjection: {
          transcriptMessageId: "uncommitted-projection",
          partIndex: 0,
          finalPart: true,
        },
      }),
    ).rejects.toThrow("promotion unavailable");
    expect(await cache.get({ accountId, chatId: 7, messageId: "5001" })).toMatchObject({
      promptContextProjectionMarker: {
        kind: "invalid",
        transcriptMessageId: "uncommitted-projection",
      },
    });
    expect(await bounded.lookup(`${keyPrefix}1`)).toMatchObject({
      sourceMessage: { message_id: 1 },
    });
    expect(await bounded.lookup(`${otherPrefix}2`)).toMatchObject({
      sourceMessage: { message_id: 2 },
    });
    expect(await bounded.count()).toBe(TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES);
    expect(await retained.count()).toBe(0);
  });

  it("settles legacy group imports larger than one move batch before persisting a DM", async () => {
    const count = 10_001;
    importPluginStateEntriesForDoctorForTests(
      "telegram",
      { namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE, maxEntries: count, env: state.env },
      Array.from({ length: count }, (_, index) => ({
        key: `${keyPrefix}${index + 1}`,
        value: { version: 1, sourceMessage: message(index + 1) },
        createdAt: index + 1,
      })),
    );
    resetPluginStateStoreForTests();
    const cache = createTelegramMessageCache({ scope });
    await cache.record({
      accountId,
      chatId: 7,
      msg: message(50000, { chat: { id: 7, type: "private", first_name: "Ada" } }),
    });
    const { bounded, retained } = openStores();
    expect(await retained.count()).toBe(count);
    expect(await bounded.count()).toBe(1);
    expect(await get(cache, 1)).toMatchObject({ messageId: "1" });
    expect(await get(cache, count)).toMatchObject({ messageId: String(count) });
  });

  it("retains group records past the old capacity and reopens without a content-sized memory cache", async () => {
    const cache = createTelegramMessageCache({ scope, maxMessages: 2 });
    for (let id = 1; id <= TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES + 1; id += 50) {
      await Promise.all(
        Array.from(
          { length: Math.min(50, TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES + 2 - id) },
          (_, offset) => record(cache, message(id + offset)),
        ),
      );
    }
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
    const reopened = createTelegramMessageCache({ scope, maxMessages: 2 });
    expect(await get(reopened, 1)).toMatchObject({ body: "Message 1", historyEligible: true });
    const latest = await history(reopened, { limit: 50 });
    expect(latest.messages.map((node) => node.messageId)).toEqual(
      Array.from({ length: 50 }, (_, index) => String(2952 + index)),
    );
    expect(latest.hasMore).toBe(true);
    expect(await history(reopened, { before: "2" })).toMatchObject({
      messages: [{ messageId: "1", body: "Message 1" }],
      hasMore: false,
    });
    const { bounded, retained } = openStores();
    expect(await bounded.count()).toBe(0);
    expect(await retained.count()).toBe(3001);
  });

  it("pages numerically through other topics while excluding unobserved snapshots and exact foreign scopes", async () => {
    const cache = createTelegramMessageCache({ scope });
    await record(cache, message(9));
    for (const id of [10, 99, 100]) {
      await record(cache, message(id, { message_thread_id: 77 }));
    }
    await record(cache, message(101, { message_thread_id: 77 }), false);
    await record(
      cache,
      message(102, {
        message_thread_id: 77,
        reply_to_message: message(8, { text: "Embedded only" }),
      }),
    );
    for (let id = 200; id < 500; id += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, offset) =>
          record(cache, message(id + offset, { message_thread_id: 88 })),
        ),
      );
    }
    await cache.record({ accountId: "other", chatId, msg: message(600), historyEligible: true });
    await cache.record({
      accountId,
      chatId: -1008,
      msg: message(600, { chat: { ...chat, id: -1008 } }),
      historyEligible: true,
    });
    const otherScope = createTelegramMessageCache({ scope: "another-session-store" });
    await record(otherScope, message(601));
    const page = await history(cache, { threadId: 77, limit: 2 });
    expect(page.messages.map((node) => node.messageId)).toEqual(["100", "102"]);
    expect(page.hasMore).toBe(true);
    const older = await history(cache, { threadId: 77, before: "100", limit: 2 });
    expect(older.messages.map((node) => node.messageId)).toEqual(["10", "99"]);
    expect(older.hasMore).toBe(false);
    expect(
      (await history(cache, { threadId: 77, after: "10", limit: 2 })).messages.map(
        (node) => node.messageId,
      ),
    ).toEqual(["99", "100"]);
    expect((await history(cache)).messages.map((node) => node.messageId)).toEqual(["9"]);
    expect((await get(cache, 8))?.historyEligible).toBeUndefined();
    expect((await history(cache, { threadId: Number.NaN })).messages).toEqual([]);
    expect(
      (await cache.recentBefore({ accountId, chatId, messageId: "103", limit: 10 })).map(
        (node) => node.messageId,
      ),
    ).toEqual(["8", "9", "10", "99", "100", "101", "102"]);
  });

  it("atomically promotes legacy roots once without trusting their embedded observations", async () => {
    const { bounded, retained } = openStores();
    const legacy = {
      sourceMessage: message(9, { reply_to_message: message(8) }),
    };
    await bounded.register(`${keyPrefix}9`, legacy);
    await bounded.register(`${keyPrefix}10`, {
      version: 1,
      sourceMessage: message(10, { text: "Old copy" }),
    });
    await retained.register(`${keyPrefix}0000000010`, {
      version: 1,
      sourceMessage: message(10, { text: "Canonical copy" }),
      historyEligible: true,
    });
    await bounded.register(`${scopeKey}:default:7:11`, {
      version: 1,
      sourceMessage: message(11, { chat: { id: 7, type: "private", first_name: "Ada" } }),
    });
    await bounded.register(`other-scope:default:${chatId}:12`, {
      version: 1,
      sourceMessage: message(12),
    });
    const cache = createTelegramMessageCache({ scope });
    expect(await get(cache, 9)).toMatchObject({ messageId: "9" });
    expect(await retained.lookup(`${keyPrefix}0000000009`)).toEqual(legacy);
    expect(await bounded.lookup(`${keyPrefix}9`)).toBeUndefined();
    expect(await bounded.lookup(`${keyPrefix}10`)).toBeUndefined();
    expect(await get(cache, 10)).toMatchObject({ body: "Canonical copy" });
    expect((await history(cache)).messages.map((node) => node.messageId)).toEqual(["10"]);
    expect(await get(cache, 8)).toBeNull();
    resetTelegramMessageCacheForTest();
    const reopened = createTelegramMessageCache({ scope });
    expect(await get(reopened, 9)).toMatchObject({ messageId: "9" });
    expect(await bounded.count()).toBe(1);
    expect(await retained.count()).toBe(3);
    expect(await bounded.lookup(`other-scope:default:${chatId}:12`)).toBeUndefined();
    expect(await retained.lookup(`other-scope:default:${chatId}:0000000012`)).toMatchObject({
      sourceMessage: { message_id: 12 },
    });
    await record(reopened, message(9));
    await record(reopened, message(20, { text: "/reset" }));
    expect(
      (await history(reopened, { before: "20" })).messages.map((node) => node.messageId),
    ).toEqual(["9", "10"]);
  });

  it("preserves embedded-only reply ancestry after legacy promotion and database reopen", async () => {
    const legacy = {
      sourceMessage: message(9, {
        message_thread_id: 77,
        reply_to_message: message(8, { caption: "Original photo", photo: photo("photo-1") }),
      }),
      threadId: "77",
    };
    await openStores().bounded.register(`${keyPrefix}9`, legacy);
    expect(await get(createTelegramMessageCache({ scope }), 9)).toMatchObject({
      messageId: "9",
    });
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();

    const reopened = createTelegramMessageCache({ scope });
    const chain = await buildTelegramReplyChain({
      cache: reopened,
      accountId,
      chatId,
      msg: message(10, { message_thread_id: 77, reply_to_message: message(9) }),
    });
    expect(chain.map((node) => node.messageId)).toEqual(["9", "8"]);
    expect(chain[1]).toMatchObject({
      body: "Original photo",
      mediaRef: "telegram:file/photo-1",
      threadId: "77",
    });
    expect(chain.map((node) => node.historyEligible)).toEqual([undefined, undefined]);
    expect(await history(reopened, { threadId: 77 })).toEqual({
      messages: [],
      hasMore: false,
    });
    expect(await get(reopened, 8)).toBeNull();
    const { bounded, retained } = openStores();
    expect(await bounded.count()).toBe(0);
    expect(await retained.count()).toBe(1);
    expect(await retained.lookup(`${keyPrefix}0000000009`)).toEqual(legacy);
  });

  it("recovers a committed promotion whose completion was interrupted", async () => {
    const { bounded, retained } = openStores();
    await bounded.register(`${keyPrefix}9`, { version: 1, sourceMessage: message(9) });
    afterMove = async () => {
      throw new Error("promotion receipt interrupted");
    };
    const cache = createTelegramMessageCache({ scope });
    await expect(get(cache, 9)).rejects.toThrow("promotion receipt interrupted");
    expect(await bounded.lookup(`${keyPrefix}9`)).toBeUndefined();
    expect(await retained.count()).toBe(1);
    resetTelegramMessageCacheForTest();
    const reopened = createTelegramMessageCache({ scope });
    expect(await get(reopened, 9)).toMatchObject({ body: "Message 9" });
    expect(await history(reopened)).toEqual({ messages: [], hasMore: false });
  });

  it("enriches missing reply ancestry without accepting stale snapshot content", async () => {
    const cache = createTelegramMessageCache({ scope });
    await record(
      cache,
      message(22, {
        text: "Edited answer",
        edit_date: 1_736_380_720,
        photo: photo("photo-2"),
      }),
    );
    await record(
      cache,
      message(23, {
        reply_to_message: message(22, {
          text: "Stale answer",
          photo: photo("photo-1"),
          reply_to_message: message(21, { text: "Original question" }),
        }),
      }),
    );
    resetTelegramMessageCacheForTest();
    const reopened = createTelegramMessageCache({ scope });
    const chain = await buildTelegramReplyChain({
      cache: reopened,
      accountId,
      chatId,
      msg: message(24, { reply_to_message: message(22) }),
    });
    expect(chain.map((node) => node.messageId)).toEqual(["22", "21"]);
    expect(chain[0]).toMatchObject({
      body: "Edited answer",
      mediaRef: "telegram:file/photo-2",
      historyEligible: true,
    });
    expect(chain[1]).toMatchObject({ body: "Original question" });
    expect(chain[1]?.historyEligible).toBeUndefined();
  });

  it("persists an explicit topicless correction while preserving genuinely unknown thread observations", async () => {
    const cache = createTelegramMessageCache({ scope });
    await cache.record({
      accountId,
      chatId,
      msg: message(9, { message_thread_id: 77 }),
      providerObservedThread: { scope: "forum", id: 77 },
      historyEligible: true,
    });
    await record(cache, message(9, { text: "Unknown thread update", edit_date: 1_736_380_720 }));
    expect((await history(cache, { threadId: 77 })).messages.map((node) => node.messageId)).toEqual(
      ["9"],
    );
    await cache.record({
      accountId,
      chatId,
      msg: message(9, {
        message_thread_id: 77,
        text: "Corrected to topicless",
        edit_date: 1_736_380_721,
      }),
      threadId: 77,
      providerObservedThread: { scope: "none" },
      historyEligible: true,
    });
    resetTelegramMessageCacheForTest();
    const reopened = createTelegramMessageCache({ scope });
    expect((await history(reopened)).messages.map((node) => node.messageId)).toEqual(["9"]);
    expect((await history(reopened, { threadId: 77 })).messages).toEqual([]);
    expect((await get(reopened, 9))?.threadId).toBeUndefined();
    expect(await openStores().retained.count()).toBe(1);
  });

  it("merges late media against a concurrently edited canonical source", async () => {
    const first = createTelegramMessageCache({ scope });
    const second = createTelegramMessageCache({ scope });
    await record(first, message(22, { photo: photo("photo-1"), caption: "Old caption" }));
    beforeCompare = async () => {
      await record(second, message(22, { photo: photo("photo-1"), edit_date: 1_736_380_720 }));
    };
    await first.recordResolvedMedia({ accountId, chatId, messageId: "22", media });
    const resolved = await get(second, 22);
    expect(resolved?.body).toBeUndefined();
    expect(resolved?.historyEligible).toBe(true);
    expect(resolved?.resolvedMedia).toMatchObject({ id: media.id });
    expect(resolved?.resolvedMedia).not.toHaveProperty("path");
    expect(resolved?.resolvedMedia).not.toHaveProperty("fileName");
    await record(
      first,
      message(23, {
        reply_to_message: message(22, {
          photo: photo("photo-1"),
          caption: "Stale caption",
        }),
      }),
    );
    expect((await get(first, 22))?.body).toBeUndefined();
  });

  it.each(["deleted", "replaced"] as const)(
    "does not resurrect or overwrite a %s message with late media",
    async (change) => {
      const cache = createTelegramMessageCache({ scope });
      const { retained } = openStores();
      await record(cache, message(22, { photo: photo("photo-1") }));
      beforeCompare = async (key) => {
        if (change === "deleted") {
          await retained.delete(key);
        } else {
          await record(
            createTelegramMessageCache({ scope }),
            message(22, {
              photo: photo("photo-2"),
              caption: "Replacement",
              edit_date: 1_736_380_720,
            }),
          );
        }
      };
      await expect(
        cache.recordResolvedMedia({ accountId, chatId, messageId: "22", media }),
      ).rejects.toThrow(change === "deleted" ? "was not recorded" : "media changed");
      const current = await get(cache, 22);
      if (change === "deleted") {
        expect(current).toBeNull();
      } else {
        expect(current).toMatchObject({ body: "Replacement", mediaRef: "telegram:file/photo-2" });
        expect(current?.resolvedMedia).toBeUndefined();
      }
    },
  );

  it("does not recreate an embedded target deleted while its partial observation commits", async () => {
    const cache = createTelegramMessageCache({ scope });
    const { retained } = openStores();
    await record(cache, message(22));
    beforeCompare = async (key) => {
      await retained.delete(key);
    };
    await record(cache, message(23, { reply_to_message: message(22) }));
    expect(await get(cache, 22)).toBeNull();
    expect((await history(cache)).messages.map((node) => node.messageId)).toEqual(["23"]);
  });

  it("does not publish a failed retained write or retry an indeterminate store failure", async () => {
    const cache = createTelegramMessageCache({ scope });
    beforeCompare = async () => {
      throw new Error("storage write failed");
    };
    await expect(record(cache, message(22))).rejects.toThrow("storage write failed");
    expect(await get(cache, 22)).toBeNull();
    expect(await history(cache)).toEqual({ messages: [], hasMore: false });
  });
});
