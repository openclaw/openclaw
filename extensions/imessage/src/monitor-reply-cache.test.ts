import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  IMESSAGE_REPLY_CACHE_COUNTER_KEY as COUNTER_KEY,
  IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES as COUNTER_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE as COUNTER_NAMESPACE,
  IMESSAGE_REPLY_CACHE_MAX_ENTRIES as CACHE_MAX_ENTRIES,
  IMESSAGE_REPLY_CACHE_NAMESPACE as CACHE_NAMESPACE,
  IMESSAGE_REPLY_CACHE_TTL_MS as CACHE_TTL_MS,
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

beforeEach(() => loadReplyCache());
afterEach(() => vi.useRealTimers());

it.each([
  [undefined, "requires a chat scope"],
  [directChat, "is no longer available. Use MessageSidFull"],
] as const)("rejects an unknown short id with scope %j", async (chatContext, error) => {
  await expect(cache.resolve("9999", { chatContext })).rejects.toThrow(error);
});

it.each([
  ["1", "MessageSidFull from another chat is rejected"],
  ["full-guid", "belongs to a different chat"],
])("rejects cross-chat reuse of %s", async (id, error) => {
  await remember("full-guid", { chatId: 42 });
  await expect(cache.resolve(id, { chatContext: { chatId: 99 } })).rejects.toThrow(error);
});

it.each([
  ["outbound-guid", false, true],
  ["inbound-guid", false, false],
  ["outbound-guid", true, false],
] as const)("checks outbound ownership for %s (foreign chat: %s)", async (id, foreign, owned) => {
  const chat = { accountId: "default", ...directChat, chatId: 3 };
  await remember("outbound-guid", { ...chat, isFromMe: true });
  await remember("inbound-guid", { ...chat, isFromMe: false });

  const context = foreign
    ? {
        accountId: "default",
        chatGuid: "any;-;+12069106514",
        chatIdentifier: "+12069106514",
        chatId: 4,
      }
    : chat;
  expect(await cache.isOwn({ ...context, messageIds: [id] })).toBe(owned);
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

it("returns the latest entry for the matching chat scope", async () => {
  await remember("older", { ...directChat, timestamp: Date.now() - 1000 });
  await remember("newest", directChat);

  expect(
    cache.latest({ accountId: "default", chatIdentifier: "iMessage;-;+12069106512" })?.messageId,
  ).toBe("newest");
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
  >({ namespace: CACHE_NAMESPACE, maxEntries: CACHE_MAX_ENTRIES });
  for (const entry of entries) {
    store.register(
      resolveIMessageReplyCacheEntryKey(entry.messageId),
      { ...context, ...entry },
      { ttlMs: CACHE_TTL_MS },
    );
  }
  createIMessagePluginStateSyncStoreForTest<{ counter: number }>({
    namespace: COUNTER_NAMESPACE,
    maxEntries: COUNTER_MAX_ENTRIES,
  }).register(COUNTER_KEY, { counter: 6 });

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

it.each([
  ["short", "work", { chatIdentifier: "+12069106512" }, true],
  ["current-guid", "work", { chatIdentifier: "+12069106512" }, true],
  ["current-guid", "other", { chatId: 42 }, false],
  ["current-guid", "work", { chatId: 99 }, false],
  ["unknown-guid", "work", { chatId: 42 }, false],
] as const)(
  "binds current message %s to account %s and chat %j",
  async (id, accountId, chatContext, matches) => {
    const entry = await remember("current-guid", workChat);
    const currentMessageId = id === "short" ? entry.shortId : id;
    expect(await cache.current({ accountId, currentMessageId, chatContext })).toBe(matches);
  },
);
