import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMESSAGE_REPLY_CACHE_COUNTER_KEY,
  IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
  IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_NAMESPACE,
  IMESSAGE_REPLY_CACHE_TTL_MS,
  resolveIMessageReplyCacheEntryKey,
} from "./state-contract.js";
import {
  createIMessagePluginStateSyncStoreForTest,
  loadFreshIMessageReplyCacheForTest,
} from "./test-support/runtime.js";

type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
async function loadApi(options?: { preservePersistentState?: boolean }) {
  const api = await loadFreshIMessageReplyCacheForTest(options);
  return {
    remember: api.rememberIMessageReplyCache,
    resolve: api.resolveIMessageMessageId,
    latest: api.findLatestIMessageEntryForChat,
    current: api.isIMessageCurrentMessageInChatAsync,
    isOwn: api.isKnownFromMeIMessageTarget,
    binding: api.resolveIMessageCachedResourceBinding,
  };
}
let cache: Awaited<ReturnType<typeof loadApi>>;
async function loadReplyCache(options?: { preservePersistentState?: boolean }) {
  cache = await loadApi(options);
}
const directChat = { chatGuid: "any;-;+12069106512", chatIdentifier: "+12069106512" };
const workChat = { accountId: "work", ...directChat, chatId: 42 };

function remember(
  messageId: string,
  overrides: Partial<Parameters<ReplyCacheModule["rememberIMessageReplyCache"]>[0]> = {},
) {
  return cache.remember({ accountId: "default", timestamp: Date.now(), ...overrides, messageId });
}

beforeEach(async () => {
  await loadReplyCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("imessage short message id resolution", () => {
  it("requires chat scope when a privileged short id is unknown", async () => {
    await expect(cache.resolve("9999")).rejects.toThrow("requires a chat scope");
  });

  it("recommends the full id when a short id has expired in the current chat", async () => {
    await expect(
      cache.resolve("9999", {
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).rejects.toThrow("is no longer available. Use MessageSidFull");
  });

  it.each([
    ["1", "MessageSidFull from another chat is rejected"],
    ["full-guid", "belongs to a different chat"],
  ])("rejects cross-chat reuse of %s", async (id, error) => {
    await remember("full-guid", { chatId: 42 });
    await expect(cache.resolve(id, { chatContext: { chatId: 99 } })).rejects.toThrow(error);
  });

  it("recognizes only cached outbound message ids as own messages", async () => {
    const chat = { accountId: "default", ...directChat, chatId: 3 };
    await remember("outbound-guid", { ...chat, isFromMe: true });
    await remember("inbound-guid", { ...chat, isFromMe: false });

    expect(await cache.isOwn({ ...chat, messageIds: ["outbound-guid"] })).toBe(true);
    expect(await cache.isOwn({ ...chat, messageIds: ["inbound-guid"] })).toBe(false);
    expect(
      await cache.isOwn({
        messageIds: ["outbound-guid"],
        accountId: "default",
        chatGuid: "any;-;+12069106514",
        chatIdentifier: "+12069106514",
        chatId: 4,
      }),
    ).toBe(false);
  });
});

it.each([false, true])("authorizes edit/unsend only for outbound entries: %s", async (isFromMe) => {
  const entry = await remember("guid", { ...directChat, isFromMe });
  const resolved = cache.resolve(entry.shortId, { chatContext: directChat, requireFromMe: true });
  if (isFromMe) {
    await expect(resolved).resolves.toBe("guid");
  } else {
    await expect(resolved).rejects.toThrow("not one this agent sent");
  }
});

describe("findLatestIMessageEntryForChat", () => {
  it("returns the latest entry for the matching chat scope", async () => {
    await remember("older", { ...directChat, timestamp: Date.now() - 1000 });
    await remember("newest", directChat);

    const result = cache.latest({
      accountId: "default",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result?.messageId).toBe("newest");
  });

  it.each([
    ["nonoverlapping identifier", {}, { accountId: "default", chatId: 99 }],
    ["foreign account", { accountId: "other" }, { accountId: "default", ...directChat }],
    [
      "stale entry",
      { timestamp: Date.now() - 12 * 60 * 1000 },
      { accountId: "default", ...directChat },
    ],
    ["missing account", {}, directChat],
  ] as const)("does not guess the latest message for %s", async (_, entry, query) => {
    await remember("message", { ...directChat, ...entry });
    expect(cache.latest(query)).toBeUndefined();
  });
});

describe("SQLite reply-cache hydration", () => {
  it("persists concurrent updates without reallocating a message short id", async () => {
    const timestamp = Date.now();
    const entries = await Promise.all([
      remember("same", { chatId: 1, timestamp }),
      remember("same", { chatId: 2, timestamp }),
      remember("other", { chatId: 3, timestamp }),
    ]);
    expect(entries.map((entry) => entry.shortId)).toEqual(["1", "1", "2"]);

    await loadReplyCache({ preservePersistentState: true });
    expect(await cache.resolve("1", { chatContext: { chatId: 2 } })).toBe("same");
    expect(await cache.resolve("2", { chatContext: { chatId: 3 } })).toBe("other");
    const next = await remember("next", { chatId: 4, timestamp });
    expect(next.shortId).toBe("3");
  });

  it("allocates above live SQLite short ids with a lagging counter after reload", async () => {
    const context = { accountId: "default", chatId: 42, timestamp: Date.now() };
    const entries = [
      { shortId: "1", messageId: "00000000-0000-4000-8000-000000000001" },
      { shortId: "7", messageId: "00000000-0000-4000-8000-000000000007" },
    ];
    const store = createIMessagePluginStateSyncStoreForTest<
      Awaited<ReturnType<ReplyCacheModule["rememberIMessageReplyCache"]>>
    >({ namespace: IMESSAGE_REPLY_CACHE_NAMESPACE, maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES });
    for (const entry of entries) {
      store.register(
        resolveIMessageReplyCacheEntryKey(entry.messageId),
        { ...context, ...entry },
        { ttlMs: IMESSAGE_REPLY_CACHE_TTL_MS },
      );
    }
    createIMessagePluginStateSyncStoreForTest<{ counter: number }>({
      namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
      maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
    }).register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, { counter: 6 });

    await loadReplyCache({ preservePersistentState: true });

    // Allocate first so a resolver cannot pre-hydrate the cache.
    const issued = await remember("00000000-0000-4000-8000-000000000008", context);
    expect(issued.shortId).toBe("8");
    for (const entry of [...entries, issued]) {
      expect(await cache.resolve(entry.shortId, { chatContext: { chatId: 42 } })).toBe(
        entry.messageId,
      );
    }
  });
});

describe("current-message chat binding", () => {
  it("preserves concrete service identity while allowing trusted any aliases", async () => {
    await remember("sms-guid", { ...workChat, chatGuid: "SMS;-;+12069106512" });
    await remember("any-guid", workChat);
    const query = { accountId: "work", chatIdentifier: "iMessage;-;+12069106512" };
    expect(await cache.binding("sms-guid", query)).toBe("mismatch");
    expect(await cache.binding("any-guid", query)).toBe("match");
  });

  it("treats expired entries as unknown before account or chat mismatches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-08T00:00:00Z"));
    await remember("expired-guid", { accountId: "work", chatId: 42 });
    vi.setSystemTime(new Date("2026-05-08T07:00:00Z"));

    expect(await cache.binding("expired-guid", { accountId: "other", chatId: 99 })).toBe("unknown");
  });

  it("matches a trusted current message through its chat identifier", async () => {
    const chatContext = { chatIdentifier: "+12069106512" };
    const entry = await remember("current-guid", workChat);
    const query = { accountId: "work", chatContext };
    expect(await cache.current({ ...query, currentMessageId: entry.shortId })).toBe(true);
    expect(await cache.current({ ...query, currentMessageId: "current-guid" })).toBe(true);
  });

  it("fails closed for wrong accounts, chats, and unknown current messages", async () => {
    await remember("current-guid", workChat);
    const query = {
      accountId: "work",
      currentMessageId: "current-guid",
      chatContext: { chatId: 42 },
    };
    expect(await cache.current({ ...query, accountId: "other" })).toBe(false);
    expect(await cache.current({ ...query, chatContext: { chatId: 99 } })).toBe(false);
    expect(await cache.current({ ...query, currentMessageId: "unknown-guid" })).toBe(false);
  });
});
