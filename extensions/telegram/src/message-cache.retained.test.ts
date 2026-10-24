import type { Message } from "grammy/types";
import {
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveProviderObservedTelegramThreadSpec } from "./message-cache-codec.js";
import {
  type PersistedTelegramMessageCacheValue,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
} from "./message-cache-persistence.js";
import {
  buildTelegramReplyChain,
  createTelegramMessageCache,
  type TelegramMessageCache as Cache,
} from "./message-cache.js";
import { photo, useMessageCacheFixture } from "./message-cache.test-support.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

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

const media = {
  id: "saved-photo.png",
  fileUniqueId: "photo-1-unique",
  size: 4,
  savedAt: 1_736_380_700_000,
  kind: "image" as const,
  path: "/private/photos/image.png",
  fileName: "private-name.png",
};

type RecordOptions = Partial<Parameters<Cache["record"]>[0]>;
function observedThread(kind: "forum" | "direct-messages", threadId = 77): RecordOptions {
  return { threadId, historyEligible: undefined, providerObservedThread: { scope: kind, id: 77 } };
}
const createCache = () => createTelegramMessageCache({ scope });
function record(cache: Cache, msg: Message, options: RecordOptions = {}) {
  return cache.record({ accountId, chatId, msg, historyEligible: true, ...options });
}

function history(cache: Cache, options: Partial<Parameters<Cache["readHistory"]>[0]> = {}) {
  return cache.readHistory({ accountId, chatId, limit: 10, ...options });
}

function get(cache: Cache, messageId: number, targetChat = chatId) {
  return cache.get({ accountId, chatId: targetChat, messageId: String(messageId) });
}

async function historyIds(cache: Cache, options: Parameters<typeof history>[1] = {}) {
  return (await history(cache, options)).messages.map((node) => node.messageId);
}

const legacyRow = (sourceMessage: Message): PersistedTelegramMessageCacheValue => ({
  version: 1,
  sourceMessage,
});
const photoMessage = (id: number, caption?: string, file = "photo-1", edit_date?: number) =>
  message(id, {
    photo: photo(file),
    ...(caption === undefined ? {} : { caption }),
    ...(edit_date === undefined ? {} : { edit_date }),
  });
const reply = (id: number, reply_to_message: Message, fields = {}) =>
  message(id, { reply_to_message, ...fields });

describe("Telegram retained message history", () => {
  const fixture = useMessageCacheFixture("telegram-history-", true);
  function openStores() {
    return {
      bounded: fixture.store<unknown>(),
      retained: fixture.store<PersistedTelegramMessageCacheValue>(true),
    };
  }
  async function counts() {
    const { bounded, retained } = openStores();
    return [await bounded.count(), await retained.count()];
  }

  function seedFullLegacyNamespace() {
    const stores = openStores();
    const otherScope = "retained-cache-other";
    const otherPrefix = `${resolveTelegramMessageCachePersistentScopeKey(otherScope)}:${accountId}:${chatId}:`;
    const privateChat = { id: 7, type: "private", first_name: "Ada" };
    importPluginStateEntriesForDoctorForTests("telegram", fixture.options(), [
      { key: `${keyPrefix}1`, value: legacyRow(message(1)), createdAt: 1000 },
      { key: `${otherPrefix}2`, value: legacyRow(message(2)), createdAt: 2000 },
      ...Array.from({ length: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES - 2 }, (_, index) => ({
        key: `${scopeKey}:${accountId}:7:${100 + index}`,
        value: legacyRow(
          message(100 + index, {
            chat: privateChat,
            ...(index === 0 ? { photo: photo("photo-1") } : {}),
          }),
        ),
        createdAt: 3000 + index,
      })),
    ]);
    return { ...stores, otherScope, otherPrefix, privateChat };
  }

  it("keeps failed promotion nonfatal for ordinary DMs without allowing bounded writes to evict history", async () => {
    const { bounded, otherPrefix, privateChat } = seedFullLegacyNamespace();
    const originalMediaRow = await bounded.lookup(`${scopeKey}:${accountId}:7:100`);
    fixture.beforeMove = async () => {
      throw new Error("promotion unavailable");
    };
    const cache = createCache();
    await expect(
      cache.record({
        accountId,
        chatId: 7,
        msg: message(5000, { chat: privateChat, text: "Memory-only DM" }),
      }),
    ).resolves.toMatchObject({ body: "Memory-only DM" });
    await cache.recordResolvedMedia({ accountId, chatId: 7, messageId: "100", media });
    expect(await get(cache, 100, 7)).toMatchObject({
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
    expect(await get(cache, 5001, 7)).toMatchObject({
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
    expect(await counts()).toEqual([TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES, 0]);
  });

  it("pages numerically through other topics while excluding unobserved snapshots and exact foreign scopes", async () => {
    const cache = createCache();
    await record(cache, message(9));
    for (const id of [10, 99, 100]) {
      await record(cache, message(id, { message_thread_id: 77 }));
    }
    await record(cache, message(101, { message_thread_id: 77 }), { historyEligible: false });
    await record(
      cache,
      reply(102, message(8, { text: "Embedded only" }), { message_thread_id: 77 }),
    );
    for (let id = 200; id < 500; id += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, offset) =>
          record(cache, message(id + offset, { message_thread_id: 88 })),
        ),
      );
    }
    await record(cache, message(600), { accountId: "other" });
    await record(cache, message(600, { chat: { ...chat, id: -1008 } }), { chatId: -1008 });
    const otherScope = createTelegramMessageCache({ scope: "another-session-store" });
    await record(otherScope, message(601));
    const page = await history(cache, { threadId: 77, limit: 2 });
    expect(page.messages.map((node) => node.messageId)).toEqual(["100", "102"]);
    expect(page.hasMore).toBe(true);
    const older = await history(cache, { threadId: 77, before: "100", limit: 2 });
    expect(older.messages.map((node) => node.messageId)).toEqual(["10", "99"]);
    expect(older.hasMore).toBe(false);
    expect(await historyIds(cache, { threadId: 77, after: "10", limit: 2 })).toEqual(["99", "100"]);
    expect(await historyIds(cache)).toEqual(["9"]);
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
    const root = legacyRow(reply(9, message(8)));
    await bounded.register(`${keyPrefix}9`, root);
    await bounded.register(`${keyPrefix}10`, legacyRow(message(10, { text: "Old copy" })));
    await retained.register(`${keyPrefix}0000000010`, {
      ...legacyRow(message(10, { text: "Canonical copy" })),
      historyEligible: true,
    });
    await bounded.register(
      `${scopeKey}:default:7:11`,
      legacyRow(message(11, { chat: { id: 7, type: "private", first_name: "Ada" } })),
    );
    await bounded.register(`other-scope:default:${chatId}:12`, legacyRow(message(12)));
    const cache = createCache();
    expect(await get(cache, 9)).toMatchObject({ messageId: "9" });
    expect(await retained.lookup(`${keyPrefix}0000000009`)).toEqual(root);
    expect(await bounded.lookup(`${keyPrefix}9`)).toBeUndefined();
    expect(await bounded.lookup(`${keyPrefix}10`)).toBeUndefined();
    expect(await get(cache, 10)).toMatchObject({ body: "Canonical copy" });
    expect(await historyIds(cache)).toEqual(["10"]);
    expect(await get(cache, 8)).toBeNull();
    resetTelegramMessageCacheForTest();
    const reopened = createCache();
    expect(await get(reopened, 9)).toMatchObject({ messageId: "9" });
    expect(await counts()).toEqual([1, 3]);
    expect(await bounded.lookup(`other-scope:default:${chatId}:12`)).toBeUndefined();
    expect(await retained.lookup(`other-scope:default:${chatId}:0000000012`)).toMatchObject({
      sourceMessage: { message_id: 12 },
    });
    await record(reopened, message(9));
    await record(reopened, message(20, { text: "/reset" }));
    expect(await historyIds(reopened, { before: "20" })).toEqual(["9", "10"]);
  });

  it("preserves embedded-only reply ancestry after legacy promotion and database reopen", async () => {
    const legacy = {
      ...legacyRow(reply(9, photoMessage(8, "Original photo"), { message_thread_id: 77 })),
      threadId: "77",
    };
    await openStores().bounded.register(`${keyPrefix}9`, legacy);
    expect(await get(createCache(), 9)).toMatchObject({ messageId: "9" });
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();

    const reopened = createCache();
    const chain = await buildTelegramReplyChain({
      cache: reopened,
      accountId,
      chatId,
      msg: reply(10, message(9), { message_thread_id: 77 }),
    });
    expect(chain.map((node) => node.messageId)).toEqual(["9", "8"]);
    expect(chain[1]).toMatchObject({
      body: "Original photo",
      mediaRef: "telegram:file/photo-1",
      threadId: "77",
    });
    expect(chain.map((node) => node.historyEligible)).toEqual([undefined, undefined]);
    expect(await history(reopened, { threadId: 77 })).toEqual({ messages: [], hasMore: false });
    expect(await get(reopened, 8)).toBeNull();
    const { retained } = openStores();
    expect(await counts()).toEqual([0, 1]);
    expect(await retained.lookup(`${keyPrefix}0000000009`)).toEqual(legacy);
  });

  it("recovers a committed promotion whose completion was interrupted", async () => {
    const { bounded, retained } = openStores();
    await bounded.register(`${keyPrefix}9`, legacyRow(message(9)));
    fixture.afterMove = async () => {
      throw new Error("promotion receipt interrupted");
    };
    const cache = createCache();
    await expect(get(cache, 9)).rejects.toThrow("promotion receipt interrupted");
    expect(await bounded.lookup(`${keyPrefix}9`)).toBeUndefined();
    expect(await retained.count()).toBe(1);
    resetTelegramMessageCacheForTest();
    const reopened = createCache();
    expect(await get(reopened, 9)).toMatchObject({ body: "Message 9" });
    expect(await history(reopened)).toEqual({ messages: [], hasMore: false });
  });

  it("persists an explicit topicless correction while preserving genuinely unknown thread observations", async () => {
    const cache = createCache();
    await record(cache, message(9, { message_thread_id: 77 }), {
      providerObservedThread: { scope: "forum", id: 77 },
    });
    await record(cache, message(9, { text: "Unknown thread update", edit_date: 1_736_380_720 }));
    expect(await historyIds(cache, { threadId: 77 })).toEqual(["9"]);
    await record(
      cache,
      message(9, {
        message_thread_id: 77,
        text: "Corrected to topicless",
        edit_date: 1_736_380_721,
      }),
      {
        threadId: 77,
        providerObservedThread: { scope: "none" },
      },
    );
    resetTelegramMessageCacheForTest();
    const reopened = createCache();
    expect(await historyIds(reopened)).toEqual(["9"]);
    expect((await history(reopened, { threadId: 77 })).messages).toEqual([]);
    expect((await get(reopened, 9))?.threadId).toBeUndefined();
    expect(await openStores().retained.count()).toBe(1);
  });

  it("preserves authenticated native thread precedence across database reopen", async () => {
    const cache = createCache();
    await record(
      cache,
      reply(30, reply(29, message(28), { message_thread_id: 88 }), { message_thread_id: 999 }),
      observedThread("forum"),
    );
    await record(
      cache,
      message(31, {
        chat: { ...chat, is_direct_messages: true },
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
      }),
      observedThread("direct-messages", 999),
    );
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
    const reopened = createCache();
    expect(resolveProviderObservedTelegramThreadSpec(await get(reopened, 30))).toEqual({
      scope: "forum",
      id: 77,
    });
    expect((await get(reopened, 29))?.threadId).toBe("88");
    expect((await get(reopened, 28))?.threadId).toBe("88");
    expect(resolveProviderObservedTelegramThreadSpec(await get(reopened, 31))).toEqual({
      scope: "direct-messages",
      id: 77,
    });
  });

  it("merges late media against a concurrently edited canonical source", async () => {
    const first = createCache();
    const second = createCache();
    await record(first, photoMessage(22, "Old caption"));
    fixture.beforeCompare = async () => {
      await record(second, photoMessage(22, undefined, "photo-1", 1_736_380_720));
    };
    await first.recordResolvedMedia({ accountId, chatId, messageId: "22", media });
    const resolved = await get(second, 22);
    expect(resolved?.body).toBeUndefined();
    expect(resolved?.historyEligible).toBe(true);
    expect(resolved?.resolvedMedia).toMatchObject({ id: media.id });
    expect(resolved?.resolvedMedia).not.toHaveProperty("path");
    expect(resolved?.resolvedMedia).not.toHaveProperty("fileName");
    await record(first, reply(23, photoMessage(22, "Stale caption")));
    expect((await get(first, 22))?.body).toBeUndefined();
  });

  it.each(["deleted", "replaced"] as const)(
    "does not resurrect or overwrite a %s message with late media",
    async (change) => {
      const cache = createCache();
      const { retained } = openStores();
      await record(cache, photoMessage(22));
      fixture.beforeCompare = async (key) => {
        if (change === "deleted") {
          await retained.delete(key);
        } else {
          await record(createCache(), photoMessage(22, "Replacement", "photo-2", 1_736_380_720));
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
    const cache = createCache();
    const { retained } = openStores();
    await record(cache, message(22));
    fixture.beforeCompare = async (key) => {
      await retained.delete(key);
    };
    await record(cache, reply(23, message(22)));
    expect(await get(cache, 22)).toBeNull();
    expect(await historyIds(cache)).toEqual(["23"]);
  });
});
