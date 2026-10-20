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
type ChatContext = Parameters<ReplyCacheModule["findLatestIMessageEntryForChat"]>[0];
async function loadApi(options?: { preservePersistentState?: boolean }) {
  const api = await loadFreshIMessageReplyCacheForTest(options);
  return {
    remember: api.rememberIMessageReplyCache,
    resolve: api.resolveIMessageMessageId,
    latest: api.findLatestIMessageEntryForChat,
    current: api.isIMessageCurrentMessageInChatAsync,
    isOwn: api.isKnownFromMeIMessageMessageId,
    binding: api.resolveIMessageCachedResourceBinding,
  };
}
let cache: Awaited<ReturnType<typeof loadApi>>;
async function loadReplyCache(options?: { preservePersistentState?: boolean }) {
  cache = await loadApi(options);
}

function remember(
  messageId: string,
  overrides: Partial<Parameters<ReplyCacheModule["rememberIMessageReplyCache"]>[0]> = {},
) {
  return cache.remember({ accountId: "default", timestamp: Date.now(), ...overrides, messageId });
}

function currentMessageInChat(
  accountId: string,
  currentMessageId: string,
  chatContext: ChatContext,
) {
  return cache.current({ accountId, currentMessageId, chatContext });
}

beforeEach(async () => {
  await loadReplyCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("imessage short message id resolution", () => {
  it("requires chat scope when a privileged short id is unknown", async () => {
    await expect(cache.resolve("9999", { requireKnownShortId: true })).rejects.toThrow(
      "requires a chat scope",
    );
  });

  it("rejects short ids from another chat", async () => {
    await remember("full-guid", { chatGuid: "iMessage;+;chat0000" });

    await expect(
      cache.resolve("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;other" },
      }),
    ).rejects.toThrow("MessageSidFull from another chat is rejected");
  });

  it("recommends the full id when a short id has expired in the current chat", async () => {
    await expect(
      cache.resolve("9999", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).rejects.toThrow("is no longer available. Use MessageSidFull");
  });

  it("guards full guid reuse across chats when cached", async () => {
    await remember("full-guid", { chatId: 42 });

    await expect(cache.resolve("full-guid", { chatContext: { chatId: 99 } })).rejects.toThrow(
      "belongs to a different chat",
    );
  });

  it("recognizes only cached outbound message ids as own messages", async () => {
    const chat = {
      accountId: "default",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 3,
    };
    await remember("outbound-guid", { ...chat, isFromMe: true });
    await remember("inbound-guid", { ...chat, isFromMe: false });

    expect(await cache.isOwn("outbound-guid", chat)).toBe(true);
    expect(await cache.isOwn("inbound-guid", chat)).toBe(false);
    expect(
      await cache.isOwn("outbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106514",
        chatIdentifier: "+12069106514",
        chatId: 4,
      }),
    ).toBe(false);
  });
});

describe("requireFromMe (edit / unsend authorization)", () => {
  it("rejects a short id resolution when the cached entry came from inbound", async () => {
    const entry = await remember("inbound-guid", { chatGuid: "iMessage;+;chatA", isFromMe: false });

    await expect(
      cache.resolve(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).rejects.toThrow("not one this agent sent");
  });

  it("allows a short id resolution when the cached entry was sent by the gateway", async () => {
    const entry = await remember("outbound-guid", { chatGuid: "iMessage;+;chatA", isFromMe: true });

    expect(
      await cache.resolve(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toBe("outbound-guid");
  });
});

describe("findLatestIMessageEntryForChat", () => {
  it("returns the latest entry for the matching chat scope", async () => {
    await remember("older", {
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now() - 1000,
    });
    await remember("newest", { chatGuid: "any;-;+12069106512", chatIdentifier: "+12069106512" });

    const result = cache.latest({
      accountId: "default",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result?.messageId).toBe("newest");
  });

  it("requires a positive identifier match — no overlap means no fallback", async () => {
    // Nonoverlapping identifier kinds must not become an implicit match.
    await remember("different-chat", { chatGuid: "iMessage;+;chat0000" });

    expect(cache.latest({ accountId: "default", chatId: 99 })).toBeUndefined();
  });

  it("never crosses account boundaries", async () => {
    await remember("foreign-account", {
      accountId: "other-account",
      chatIdentifier: "+12069106512",
    });

    expect(cache.latest({ accountId: "default", chatIdentifier: "+12069106512" })).toBeUndefined();
  });

  it("ignores entries older than the recency window", async () => {
    const TWELVE_MINUTES_AGO = Date.now() - 12 * 60 * 1000;
    await remember("stale", { chatIdentifier: "+12069106512", timestamp: TWELVE_MINUTES_AGO });

    expect(cache.latest({ accountId: "default", chatIdentifier: "+12069106512" })).toBeUndefined();
  });

  it("requires accountId — refuses to guess across all known chats", async () => {
    await remember("anywhere", { chatIdentifier: "+12069106512" });

    expect(cache.latest({ chatIdentifier: "+12069106512" })).toBeUndefined();
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
      expect(
        await cache.resolve(entry.shortId, {
          requireKnownShortId: true,
          chatContext: { chatId: context.chatId },
        }),
      ).toBe(entry.messageId);
    }
  });
});

describe("current-message chat binding", () => {
  it("preserves concrete service identity while allowing trusted any aliases", async () => {
    await remember("sms-guid", {
      accountId: "work",
      chatGuid: "SMS;-;+12069106512",
      chatIdentifier: "+12069106512",
    });
    await remember("any-guid", {
      accountId: "work",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
    });

    expect(
      await cache.binding("sms-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+12069106512",
      }),
    ).toBe("mismatch");
    expect(
      await cache.binding("any-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+12069106512",
      }),
    ).toBe("match");
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
    const entry = await remember("current-guid", {
      accountId: "work",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 42,
    });

    expect(await currentMessageInChat("work", entry.shortId, chatContext)).toBe(true);
    expect(await currentMessageInChat("work", "current-guid", chatContext)).toBe(true);
  });

  it("fails closed for wrong accounts, chats, and unknown current messages", async () => {
    await remember("current-guid", {
      accountId: "work",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 42,
    });

    expect(await currentMessageInChat("other", "current-guid", { chatId: 42 })).toBe(false);
    expect(await currentMessageInChat("work", "current-guid", { chatId: 99 })).toBe(false);
    expect(await currentMessageInChat("work", "unknown-guid", { chatId: 42 })).toBe(false);
  });
});
