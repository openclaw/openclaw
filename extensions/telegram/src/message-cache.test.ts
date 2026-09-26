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
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  type PersistedTelegramMessageCacheValue,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import { buildTelegramReplyChain, createTelegramMessageCache } from "./message-cache.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest as resetCache,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
type Cache = ReturnType<typeof createTelegramMessageCache>;
type PersistedValue = Omit<
  PersistedTelegramMessageCacheValue,
  "version" | "threadBinding" | "promptContextProjection"
> & {
  version?: number;
  threadBinding?: unknown;
  promptContextProjection?: unknown;
};

const sender = (id: number, first_name: string, is_bot = false) => ({ id, is_bot, first_name });

function message(message_id: number, firstName: string, overrides: Record<string, unknown> = {}) {
  const { chat, date, from, ...rest } = overrides;
  return {
    chat: chat ?? { id: 7, type: "private", first_name: firstName },
    message_id,
    date: date ?? 1_736_371_600 + message_id,
    from: from ?? sender(1, firstName),
    ...rest,
  } as Message;
}

function photo(file_id: string) {
  return [{ file_id, file_unique_id: `${file_id}-unique`, width: 640, height: 480 }];
}

function botMessage(messageId: number, text: string, overrides: Record<string, unknown> = {}) {
  return message(messageId, "OpenClaw", {
    text,
    from: sender(999, "OpenClaw", true),
    ...overrides,
  });
}

function record(cache: Cache, msg: Message, overrides: Record<string, unknown> = {}) {
  return cache.record({ accountId: "default", chatId: 7, msg, ...overrides } as never);
}

function get(cache: Cache, messageId: string, overrides: Record<string, unknown> = {}) {
  return cache.get({ accountId: "default", chatId: 7, messageId, ...overrides } as never);
}

function reloadGet(messageId: string) {
  resetCache();
  resetPluginStateStoreForTests();
  return get(createTelegramMessageCache(), messageId);
}
function recentBefore(cache: Cache, messageId: string, overrides: Record<string, unknown> = {}) {
  return cache.recentBefore({
    accountId: "default",
    chatId: 7,
    messageId,
    limit: 10,
    ...overrides,
  } as never);
}

const replyChain = (cache: Cache, msg: Message, chatId = 7) =>
  buildTelegramReplyChain({ cache, accountId: "default", chatId, msg });

const projection = (transcriptMessageId: string) => ({
  transcriptMessageId,
  partIndex: 0,
  finalPart: true,
});

describe("telegram message cache", () => {
  let state: OpenClawTestState;
  let store: PluginStateKeyedStore<PersistedValue>;
  let failWrite: boolean;
  const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
  const key = (messageId: string) => `${scopeKey}:default:7:${messageId}`;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "telegram-cache-", layout: "state-only" });
    failWrite = false;
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ) => {
      const backing = createPluginStateKeyedStoreForTests<T>("telegram", {
        ...options,
        env: state.env,
      });
      return {
        ...backing,
        async register(...args: Parameters<typeof backing.register>) {
          if (failWrite) {
            throw new Error("state store unavailable");
          }
          return backing.register(...args);
        },
      };
    };
    setTelegramRuntime(createPluginRuntimeMock({ state: { openKeyedStore } }));
    store = createPluginStateKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
      env: state.env,
    });
  });

  afterEach(async () => {
    resetCache();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it("persists resolved media with its source message and drops it when the media changes", async () => {
    const cache = createTelegramMessageCache();
    await record(cache, message(9000, "Kesava", { photo: photo("photo-1") }));
    const downloadedMedia = {
      id: "saved-photo.png",
      fileUniqueId: "photo-1-unique",
      size: 4,
      savedAt: 1_736_380_700_000,
      kind: "image" as const,
      contentType: "image/png",
      path: "/private/user/photos/holiday.png",
      fileName: "holiday photo.png",
    };
    await cache.recordResolvedMedia({
      accountId: "default",
      chatId: 7,
      messageId: "9000",
      media: downloadedMedia,
    });

    const reloaded = await reloadGet("9000");
    expect(reloaded?.resolvedMedia).toMatchObject({
      id: "saved-photo.png",
      fileUniqueId: "photo-1-unique",
      kind: "image",
    });

    const reloadedCache = createTelegramMessageCache();
    await record(reloadedCache, message(9000, "Kesava", { photo: photo("photo-2") }));
    expect((await get(reloadedCache, "9000"))?.resolvedMedia).toBeUndefined();
  });

  it("resolves external reply references only from the same chat without inventing message bodies", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: -1001, type: "supergroup", title: "Local group" };
    await record(cache, message(9, "Ada", { chat, text: "Local body" }), { chatId: chat.id });
    const reference = (peerId: number, messageId: number) =>
      message(11, "Ada", {
        chat,
        external_reply: {
          origin: {
            type: "chat",
            date: 1_736_371_609,
            sender_chat: { ...chat, id: peerId },
          },
          chat: { ...chat, id: peerId },
          message_id: messageId,
        },
      });

    expect(await replyChain(cache, reference(-1002, 9), chat.id)).toEqual([]);
    expect(await replyChain(cache, reference(chat.id, 8), chat.id)).toEqual([]);
    expect(await replyChain(cache, reference(chat.id, 9), chat.id)).toMatchObject([
      { messageId: "9", body: "Local body" },
    ]);
  });

  it("keeps a cached dice roll readable as a reply target", async () => {
    // The cache derives its own body rather than reusing the inbound one. Before dice was handled
    // here, replying to a roll produced a cached node with an empty body, so the roll never
    // reached the agent as reply context.
    const cache = createTelegramMessageCache();
    const roll = message(9100, "Ada", {
      from: sender(2, "Ada"),
      dice: { emoji: "\u{1F3B2}", value: 4 },
    });
    await record(cache, roll);

    const chain = await replyChain(
      cache,
      message(9101, "Grace", {
        text: "what did it land on?",
        from: sender(3, "Grace"),
        reply_to_message: roll,
      }),
    );

    expect(chain).toMatchObject([{ messageId: "9100", body: "[Dice \u{1F3B2} = 4]" }]);
  });

  it("prefers exact stored ancestors over stale embedded content and topic metadata", async () => {
    const cache = createTelegramMessageCache();
    await record(
      cache,
      message(8, "Ada", {
        caption: "Corrected photo",
        photo: photo("photo-2"),
        edit_date: 1_736_380_720,
      }),
      { providerObservedThread: { scope: "none" } },
    );
    const chain = await replyChain(
      cache,
      message(10, "Grace", {
        message_thread_id: 77,
        reply_to_message: message(9, "Lin", {
          reply_to_message: message(8, "Ada", {
            caption: "Stale photo",
            photo: photo("photo-1"),
            message_thread_id: 77,
            reply_to_message: message(7, "Lin", { text: "Stale ancestry" }),
          }),
        }),
      }),
    );
    expect(chain.map((node) => node.messageId)).toEqual(["9", "8"]);
    expect(chain[1]).toMatchObject({
      body: "Corrected photo",
      mediaRef: "telegram:file/photo-2",
    });
    expect(chain[1]?.threadId).toBeUndefined();
    expect(chain[1]?.replyToId).toBeUndefined();
  });

  it("does not borrow local message identities from cross-chat embedded replies", async () => {
    const cache = createTelegramMessageCache();
    await record(cache, message(8, "Ada", { text: "Unrelated local message" }));
    const chain = await replyChain(
      cache,
      message(10, "Grace", {
        reply_to_message: message(9, "Lin", {
          reply_to_message: message(8, "Ada", {
            chat: { id: -1002, type: "supergroup", title: "Other chat" },
            text: "Foreign snapshot",
          }),
        }),
      }),
    );
    expect(chain.map((node) => node.messageId)).toEqual(["9"]);
  });

  it("propagates ancestor lookup failures instead of using an embedded snapshot", async () => {
    const cache = createTelegramMessageCache();
    const unavailable: Cache = {
      ...cache,
      async get(params) {
        if (params.messageId === "8") {
          throw new Error("ancestor lookup unavailable");
        }
        return cache.get(params);
      },
    };
    await expect(
      replyChain(
        unavailable,
        message(10, "Grace", {
          reply_to_message: message(9, "Lin", {
            reply_to_message: message(8, "Ada", { text: "Stale fallback" }),
          }),
        }),
      ),
    ).rejects.toThrow("ancestor lookup unavailable");
  });

  it.each([
    { boundary: "depth cap", ids: [9, 8, 7, 6, 5], expected: ["9", "8", "7", "6"] },
    { boundary: "cycle", ids: [9, 8, 9], expected: ["9", "8"] },
  ])("bounds embedded-only reply traversal at the $boundary", async ({ ids, expected }) => {
    const cache = createTelegramMessageCache();
    let reply: Message | undefined;
    for (const id of ids.toReversed()) {
      reply = message(id, "Ada", reply ? { reply_to_message: reply } : {});
    }
    const chain = await replyChain(cache, message(10, "Grace", { reply_to_message: reply }));
    expect(chain.map((node) => node.messageId)).toEqual(expected);
  });

  it("persists prompt-context projection provenance across cache restart", async () => {
    const marker = projection("assistant-projection-restart");
    const cache = createTelegramMessageCache();
    await record(cache, botMessage(9125, "Projection-aware state message"), {
      promptContextProjection: marker,
    });

    resetCache();
    const reloadedCache = createTelegramMessageCache();
    const reloaded = await get(reloadedCache, "9125");
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });

    const edited = await record(
      reloadedCache,
      botMessage(9125, "Edited projection-aware state message", { edit_date: 1_736_380_730 }),
    );
    expect(edited).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection: marker },
    });

    const editedReloaded = await reloadGet("9125");
    expect(editedReloaded).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection: marker },
    });

    await store.register(key("9125"), {
      ...(await store.lookup(key("9125")))!,
      promptContextProjection: { ...marker, partIndex: -1 },
    });
    resetCache();
    const malformedCache = createTelegramMessageCache();
    const malformed = await get(malformedCache, "9125");
    expect(malformed?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: marker.transcriptMessageId,
    });

    await record(
      malformedCache,
      botMessage(9125, "Edited malformed projection state message", { edit_date: 1_736_380_731 }),
    );
    expect((await store.lookup(key("9125")))?.promptContextProjection).toEqual({
      transcriptMessageId: marker.transcriptMessageId,
    });

    const malformedReloaded = await reloadGet("9125");
    expect(malformedReloaded?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: marker.transcriptMessageId,
    });
  });

  it("recognizes projected messages sent on behalf of a Telegram Business account", async () => {
    const marker = projection("assistant-business-projection");
    const businessMessage = message(9128, "Business User", {
      text: "Business reply",
      from: sender(700, "Business User"),
      sender_business_bot: sender(42, "OpenClaw", true),
    });
    const cache = createTelegramMessageCache();
    const live = await record(cache, businessMessage, {
      botUserId: 42,
      promptContextProjection: marker,
    });
    expect(live.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });

    const reloaded = await reloadGet("9128");
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });

    await store.register(key("9128"), {
      ...(await store.lookup(key("9128")))!,
      botUserId: 99,
    });
    const mismatched = await reloadGet("9128");
    expect(mismatched?.promptContextProjectionMarker).toBeUndefined();
  });

  it("preserves projected message whitespace across cache restart", async () => {
    const marker = projection("assistant-whitespace-projection");
    const text = "  indented\nnext  \n";
    const cache = createTelegramMessageCache();
    const live = await record(
      cache,
      message(9132, "OpenClaw", { text, from: sender(42, "OpenClaw", true) }),
      {
        botUserId: 42,
        promptContextProjection: marker,
      },
    );
    expect(live.body).toBe(text);

    const reloaded = await reloadGet("9132");
    expect(reloaded?.body).toBe(text);
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });
  });

  it("poisons projection provenance when its durable cache write fails", async () => {
    failWrite = true;
    const cache = createTelegramMessageCache();
    await expect(
      record(cache, message(9126, "Nora", { text: "Markerless context" })),
    ).resolves.toMatchObject({ messageId: "9126" });

    const marker = projection("assistant-persistence-failure");
    await expect(
      record(cache, botMessage(9127, "Projected context"), { promptContextProjection: marker }),
    ).rejects.toThrow("state store unavailable");
    await expect(get(cache, "9127")).resolves.toMatchObject({
      promptContextProjectionMarker: {
        kind: "invalid",
        transcriptMessageId: marker.transcriptMessageId,
      },
    });
  });

  it.each([
    ["projected row first", ["projected", "parent"]],
    ["embedding parent first", ["parent", "projected"]],
  ])("keeps projected bot provenance when hydrating $0", async (_name, order) => {
    const marker = projection("assistant-embedded-order");
    const bot = botMessage(9130, "Projected answer");
    const values: Record<string, [string, PersistedValue]> = {
      projected: [
        `${scopeKey}:default:7:9130`,
        { version: 1, sourceMessage: bot, promptContextProjection: marker },
      ],
      parent: [
        `${scopeKey}:default:7:9131`,
        {
          version: 1,
          sourceMessage: message(9131, "Nora", {
            text: "Replying to the answer",
            reply_to_message: bot,
          }),
        },
      ],
    };
    importPluginStateEntriesForDoctorForTests(
      "telegram",
      {
        namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
        maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
        env: state.env,
      },
      order.map((name, index) => {
        const [entryKey, value] = values[name]!;
        return { key: entryKey, value, createdAt: 1000 + index };
      }),
    );

    const hydrated = await get(createTelegramMessageCache(), "9130");
    expect(hydrated?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });
  });

  it("ignores persisted projection metadata on inbound messages", async () => {
    await store.register(key("9140"), {
      version: 1,
      sourceMessage: message(9140, "Nora", { text: "Inbound text" }),
      promptContextProjection: projection("must-not-be-trusted"),
    });

    const hydrated = await get(createTelegramMessageCache(), "9140");
    expect(hydrated?.promptContextProjectionMarker).toBeUndefined();
  });

  it("hydrates unversioned pre-projection rows without inferring provenance", async () => {
    await store.register(key("9126"), {
      sourceMessage: botMessage(9126, "Pre-projection state message"),
      promptContextProjection: projection("must-not-be-inferred"),
      threadBinding: { kind: "provider-observed-v1", threadId: "77" },
      threadId: "77",
    });

    resetCache();
    const reloaded = await get(createTelegramMessageCache(), "9126");
    expect(reloaded).toMatchObject({
      body: "Pre-projection state message",
      messageId: "9126",
    });
    expect(reloaded?.promptContextProjectionMarker).toBeUndefined();
    expect(hasProviderObservedTelegramThreadBinding(reloaded, 77)).toBe(false);
  });

  it("rejects unknown future persisted cache versions", async () => {
    await store.register(key("9127"), {
      version: 2,
      sourceMessage: message(9127, "Nora", {
        text: "Future state message",
      }),
    });

    const cache = createTelegramMessageCache();
    expect(await get(cache, "9127")).toBeNull();
  });

  it("does not partially parse malformed persisted thread ids", async () => {
    const cache = createTelegramMessageCache();
    await record(
      cache,
      message(9126, "Nora", {
        date: 1_736_389_126,
        text: "State topic message",
      }),
      { threadId: 100 },
    );

    await store.register(key("9126"), {
      ...(await store.lookup(key("9126")))!,
      threadId: "0x64",
    });

    resetCache();
    const recent = await recentBefore(createTelegramMessageCache(), "9127", { threadId: 100 });
    expect(recent).toEqual([]);
  });

  it("drops unsafe Telegram thread ids from live messages", async () => {
    const cache = createTelegramMessageCache();
    await record(
      cache,
      message(9127, "Nora", {
        date: 1_736_389_127,
        message_thread_id: Number.MAX_SAFE_INTEGER + 1,
        text: "Unsafe topic message",
      }),
    );

    expect((await store.lookup(key("9127")))?.threadId).toBeUndefined();
    const topicRecent = await recentBefore(cache, "9128", {
      threadId: Number.MAX_SAFE_INTEGER + 1,
    });
    const unscopedRecent = await recentBefore(cache, "9128");

    expect(topicRecent).toEqual([]);
    expect(unscopedRecent.map((entry) => entry.messageId)).toEqual(["9127"]);
  });

  it("does not use unsafe message ids as recent-before cutoffs", async () => {
    const cache = createTelegramMessageCache();
    await record(cache, message(9124, "Nora", { date: 1_736_380_700, text: "State message" }));
    const recent = await recentBefore(cache, "9007199254740992");

    expect(recent).toEqual([]);
  });
});
