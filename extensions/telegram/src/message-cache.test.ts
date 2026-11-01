import type { Message } from "grammy/types";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  type PersistedTelegramMessageCacheValue,
} from "./message-cache-persistence.js";
import { buildTelegramReplyChain, createTelegramMessageCache } from "./message-cache.js";
import { photo, useMessageCacheFixture } from "./message-cache.test-support.js";
import { resetTelegramMessageCacheForTest as resetCache } from "./runtime.test-support.js";
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
const accountId = "default";
const chatId = 7;

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

const botMessage = (messageId: number, text: string, overrides: Record<string, unknown> = {}) =>
  message(messageId, "OpenClaw", {
    text,
    from: sender(999, "OpenClaw", true),
    ...overrides,
  });

function expectProjection(
  node: Awaited<ReturnType<Cache["get"]>>,
  marker: ReturnType<typeof projection>,
  kind: "valid" | "invalid" = "valid",
) {
  expect(node?.promptContextProjectionMarker).toEqual(
    kind === "valid"
      ? { kind, projection: marker }
      : { kind, transcriptMessageId: marker.transcriptMessageId },
  );
}

const reply = (id: number, name: string, reply_to_message: Message, fields = {}) =>
  message(id, name, { reply_to_message, ...fields });

const projection = (transcriptMessageId: string) => ({
  transcriptMessageId,
  partIndex: 0,
  finalPart: true,
});

describe("telegram message cache", () => {
  const fixture = useMessageCacheFixture("telegram-cache-");
  let store: PluginStateKeyedStore<PersistedValue>;
  let cache: Cache;
  const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
  const key = (messageId: string) => `${scopeKey}:default:7:${messageId}`;
  const record = (msg: Message, overrides: Partial<Parameters<Cache["record"]>[0]> = {}) =>
    cache.record({ accountId, chatId, msg, ...overrides });
  const get = (messageId: string) => cache.get({ accountId, chatId, messageId });
  const replyChain = (msg: Message, targetChat = chatId) =>
    buildTelegramReplyChain({ cache, accountId, chatId: targetChat, msg });
  function reopen(resetStore = false) {
    resetCache();
    if (resetStore) {
      resetPluginStateStoreForTests();
    }
    cache = createTelegramMessageCache();
  }
  function reloadGet(id: string) {
    reopen(true);
    return get(id);
  }
  async function updateRow(id: string, fields: Partial<PersistedValue>) {
    await store.register(key(id), { ...(await store.lookup(key(id)))!, ...fields });
  }

  beforeEach(() => {
    store = fixture.store<PersistedValue>();
    cache = createTelegramMessageCache();
  });

  it("persists resolved media with its source message and drops it when the media changes", async () => {
    await record(message(9000, "Kesava", { photo: photo("photo-1") }));
    const media = {
      id: "saved-photo.png",
      fileUniqueId: "photo-1-unique",
      size: 4,
      savedAt: 1_736_380_700_000,
      kind: "image" as const,
      contentType: "image/png",
    };
    await cache.recordResolvedMedia({
      accountId,
      chatId,
      messageId: "9000",
      media,
    });
    expect((await reloadGet("9000"))?.resolvedMedia).toMatchObject(media);

    await record(message(9000, "Kesava", { photo: photo("photo-2") }));
    expect((await get("9000"))?.resolvedMedia).toBeUndefined();
  });

  it("resolves external reply references only from the same chat without inventing message bodies", async () => {
    const chat = { id: -1001, type: "supergroup", title: "Local group" };
    await record(message(9, "Ada", { chat, text: "Local body" }), { chatId: chat.id });
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

    expect(await replyChain(reference(-1002, 9), chat.id)).toEqual([]);
    expect(await replyChain(reference(chat.id, 8), chat.id)).toEqual([]);
    expect(await replyChain(reference(chat.id, 9), chat.id)).toMatchObject([
      { messageId: "9", body: "Local body" },
    ]);
  });

  it("prefers exact stored ancestors over stale embedded content and topic metadata", async () => {
    await record(
      message(8, "Ada", {
        caption: "Corrected photo",
        photo: photo("photo-2"),
        edit_date: 1_736_380_720,
      }),
      { providerObservedThread: { scope: "none" } },
    );
    const stale = reply(8, "Ada", message(7, "Lin", { text: "Stale ancestry" }), {
      caption: "Stale photo",
      photo: photo("photo-1"),
      message_thread_id: 77,
    });
    const chain = await replyChain(
      reply(10, "Grace", reply(9, "Lin", stale), { message_thread_id: 77 }),
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
    await record(message(8, "Ada", { text: "Unrelated local message" }));
    const foreign = message(8, "Ada", {
      chat: { id: -1002, type: "supergroup", title: "Other chat" },
      text: "Foreign snapshot",
    });
    const chain = await replyChain(reply(10, "Grace", reply(9, "Lin", foreign)));
    expect(chain.map((node) => node.messageId)).toEqual(["9"]);
  });

  it("persists prompt-context projection provenance across cache restart", async () => {
    const marker = projection("assistant-projection-restart");
    const text = "  indented\nnext  \n";
    const live = await record(botMessage(9125, text), {
      botUserId: 999,
      promptContextProjection: marker,
    });
    expect(live.body).toBe(text);

    reopen();
    const reloaded = await get("9125");
    expect(reloaded?.body).toBe(text);
    expectProjection(reloaded, marker);

    const editedText = "Edited projection";
    const edited = await record(botMessage(9125, editedText, { edit_date: 1_736_380_730 }));
    const expected = {
      body: editedText,
      promptContextProjectionMarker: { kind: "valid", projection: marker },
    };
    expect(edited).toMatchObject(expected);
    expect(await reloadGet("9125")).toMatchObject(expected);
    await updateRow("9125", { promptContextProjection: { ...marker, partIndex: -1 } });
    reopen();
    expectProjection(await get("9125"), marker, "invalid");

    await record(botMessage(9125, "Edited malformed projection", { edit_date: 1_736_380_731 }));
    expect((await store.lookup(key("9125")))?.promptContextProjection).toEqual({
      transcriptMessageId: marker.transcriptMessageId,
    });

    expectProjection(await reloadGet("9125"), marker, "invalid");
  });

  it("recognizes projected messages sent on behalf of a Telegram Business account", async () => {
    const marker = projection("assistant-business-projection");
    const businessMessage = message(9128, "Business User", {
      text: "Business reply",
      from: sender(700, "Business User"),
      sender_business_bot: sender(42, "OpenClaw", true),
    });
    expectProjection(
      await record(businessMessage, { botUserId: 42, promptContextProjection: marker }),
      marker,
    );
    expectProjection(await reloadGet("9128"), marker);

    await updateRow("9128", { botUserId: 99 });
    expect((await reloadGet("9128"))?.promptContextProjectionMarker).toBeUndefined();
  });

  it.each([
    ["projected row first", ["projected", "parent"]],
    ["embedding parent first", ["parent", "projected"]],
  ])("keeps projected bot provenance when hydrating $0", async (_name, order) => {
    const marker = projection("assistant-embedded-order");
    const bot = botMessage(9130, "Projected answer");
    const values: Record<string, PersistedValue> = {
      projected: { version: 1, sourceMessage: bot, promptContextProjection: marker },
      parent: { version: 1, sourceMessage: reply(9131, "Nora", bot) },
    };
    importPluginStateEntriesForDoctorForTests(
      "telegram",
      fixture.options(),
      order.map((name, index) => {
        const value = values[name]!;
        return { key: key(String(value.sourceMessage.message_id)), value, createdAt: 1000 + index };
      }),
    );

    expectProjection(await get("9130"), marker);
  });

  it("ignores persisted projection metadata on inbound messages", async () => {
    await store.register(key("9140"), {
      version: 1,
      sourceMessage: message(9140, "Nora", { text: "Inbound text" }),
      promptContextProjection: projection("must-not-be-trusted"),
    });

    expect((await get("9140"))?.promptContextProjectionMarker).toBeUndefined();
  });

  it("ignores unversioned cache rows without rewriting them", async () => {
    const persisted = {
      sourceMessage: botMessage(9126, "Pre-projection state message"),
      promptContextProjection: projection("must-not-be-inferred"),
      threadBinding: { kind: "provider-observed-v1", threadId: "77" },
      threadId: "77",
    };
    await store.register(key("9126"), persisted);

    reopen();
    await expect(get("9126")).resolves.toBeNull();
    await expect(store.lookup(key("9126"))).resolves.toEqual(persisted);
  });

  it("does not partially parse malformed persisted thread ids", async () => {
    await record(message(9126, "Nora", { date: 1_736_389_126, text: "State topic message" }), {
      threadId: 100,
    });

    await updateRow("9126", { threadId: "0x64" });

    reopen();
    expect(
      await cache.recentBefore({ accountId, chatId, messageId: "9127", threadId: 100, limit: 10 }),
    ).toEqual([]);
  });

  it("does not use unsafe message ids as recent-before cutoffs", async () => {
    await record(message(9124, "Nora", { date: 1_736_380_700, text: "State message" }));
    expect(
      await cache.recentBefore({ accountId, chatId, messageId: "9007199254740992", limit: 10 }),
    ).toEqual([]);
  });
});
