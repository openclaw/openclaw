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
let findLatestIMessageEntryForChat: ReplyCacheModule["findLatestIMessageEntryForChat"];
let isIMessageCurrentMessageInChatAsync: ReplyCacheModule["isIMessageCurrentMessageInChatAsync"];
let isKnownFromMeIMessageMessageId: ReplyCacheModule["isKnownFromMeIMessageMessageId"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let resolveIMessageCachedResourceBinding: ReplyCacheModule["resolveIMessageCachedResourceBinding"];
let resolveIMessageMessageId: ReplyCacheModule["resolveIMessageMessageId"];

async function loadReplyCache(options?: { preservePersistentState?: boolean }): Promise<void> {
  ({
    findLatestIMessageEntryForChat,
    isIMessageCurrentMessageInChatAsync,
    isKnownFromMeIMessageMessageId,
    rememberIMessageReplyCache,
    resolveIMessageCachedResourceBinding,
    resolveIMessageMessageId,
  } = await loadFreshIMessageReplyCacheForTest(options));
}

beforeEach(async () => {
  await loadReplyCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("imessage short message id resolution", () => {
  it("requires chat scope when a privileged short id is unknown", async () => {
    await expect(resolveIMessageMessageId("9999", { requireKnownShortId: true })).rejects.toThrow(
      "requires a chat scope",
    );
  });

  it("rejects short ids from another chat", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    await expect(
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;other" },
      }),
    ).rejects.toThrow("MessageSidFull from another chat is rejected");
  });

  it("recommends the full id when a short id has expired in the current chat", async () => {
    await expect(
      resolveIMessageMessageId("9999", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).rejects.toThrow("is no longer available. Use MessageSidFull");
  });

  it("guards full guid reuse across chats when cached", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatId: 42,
      timestamp: Date.now(),
    });

    await expect(
      resolveIMessageMessageId("full-guid", { chatContext: { chatId: 99 } }),
    ).rejects.toThrow("belongs to a different chat");
  });

  it("recognizes only cached outbound message ids as own messages", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: true,
    });
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "inbound-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: false,
    });

    expect(
      await isKnownFromMeIMessageMessageId("outbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106512",
        chatIdentifier: "+12069106512",
        chatId: 3,
      }),
    ).toBe(true);
    expect(
      await isKnownFromMeIMessageMessageId("inbound-guid", {
        accountId: "default",
        chatGuid: "any;-;+12069106512",
        chatIdentifier: "+12069106512",
        chatId: 3,
      }),
    ).toBe(false);
    expect(
      await isKnownFromMeIMessageMessageId("outbound-guid", {
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
    // The default inbound recorder sets isFromMe:false (or omits it), so
    // resolving with requireFromMe must reject — agents cannot edit/unsend
    // messages that other participants sent.
    const entry = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "inbound-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: false,
    });

    await expect(
      resolveIMessageMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).rejects.toThrow("not one this agent sent");
  });

  it("allows a short id resolution when the cached entry was sent by the gateway", async () => {
    const entry = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: true,
    });

    expect(
      await resolveIMessageMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).toBe("outbound-guid");
  });
});

describe("findLatestIMessageEntryForChat", () => {
  it("returns the latest entry for the matching chat scope", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "older",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now() - 1000,
    });
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "newest",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    const result = findLatestIMessageEntryForChat({
      accountId: "default",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result?.messageId).toBe("newest");
  });

  it("requires a positive identifier match — no overlap means no fallback", async () => {
    // Cache entry has only chatGuid; caller has only chatId. With the old
    // isCrossChatMismatch-as-filter, this entry would have been returned
    // (no overlap → no mismatch → pass). The strict positive-match
    // semantics require both sides to share at least one identifier kind.
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "different-chat",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(findLatestIMessageEntryForChat({ accountId: "default", chatId: 99 })).toBeUndefined();
  });

  it("never crosses account boundaries", async () => {
    await rememberIMessageReplyCache({
      accountId: "other-account",
      messageId: "foreign-account",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("ignores entries older than the recency window", async () => {
    const TWELVE_MINUTES_AGO = Date.now() - 12 * 60 * 1000;
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "stale",
      chatIdentifier: "+12069106512",
      timestamp: TWELVE_MINUTES_AGO,
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("requires accountId — refuses to guess across all known chats", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "anywhere",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    // accountId is optional in the signature; calling without it exercises the
    // runtime guard that returns undefined rather than a cross-account match.
    expect(findLatestIMessageEntryForChat({ chatIdentifier: "+12069106512" })).toBeUndefined();
  });
});

describe("SQLite reply-cache hydration", () => {
  it("persists concurrent updates without reallocating a message short id", async () => {
    const timestamp = Date.now();
    const entries = await Promise.all([
      rememberIMessageReplyCache({ accountId: "default", messageId: "same", chatId: 1, timestamp }),
      rememberIMessageReplyCache({ accountId: "default", messageId: "same", chatId: 2, timestamp }),
      rememberIMessageReplyCache({
        accountId: "default",
        messageId: "other",
        chatId: 3,
        timestamp,
      }),
    ]);
    expect(entries.map((entry) => entry.shortId)).toEqual(["1", "1", "2"]);

    await loadReplyCache({ preservePersistentState: true });
    expect(await resolveIMessageMessageId("1", { chatContext: { chatId: 2 } })).toBe("same");
    expect(await resolveIMessageMessageId("2", { chatContext: { chatId: 3 } })).toBe("other");
    const next = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "next",
      chatId: 4,
      timestamp,
    });
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
    >({
      namespace: IMESSAGE_REPLY_CACHE_NAMESPACE,
      maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
    });
    for (const entry of entries) {
      store.register(
        resolveIMessageReplyCacheEntryKey(entry.messageId),
        { ...context, ...entry },
        {
          ttlMs: IMESSAGE_REPLY_CACHE_TTL_MS,
        },
      );
    }
    createIMessagePluginStateSyncStoreForTest<{ counter: number }>({
      namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
      maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
    }).register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, { counter: 6 });

    await loadReplyCache({ preservePersistentState: true });

    // Allocate first so a resolver cannot pre-hydrate the cache.
    const issued = await rememberIMessageReplyCache({
      ...context,
      messageId: "00000000-0000-4000-8000-000000000008",
    });
    expect(issued.shortId).toBe("8");
    for (const entry of [...entries, issued]) {
      expect(
        await resolveIMessageMessageId(entry.shortId, {
          requireKnownShortId: true,
          chatContext: { chatId: context.chatId },
        }),
      ).toBe(entry.messageId);
    }
  });
});

describe("current-message chat binding", () => {
  it("preserves concrete service identity while allowing trusted any aliases", async () => {
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "sms-guid",
      chatGuid: "SMS;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "any-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    expect(
      await resolveIMessageCachedResourceBinding("sms-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+12069106512",
      }),
    ).toBe("mismatch");
    expect(
      await resolveIMessageCachedResourceBinding("any-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+12069106512",
      }),
    ).toBe("match");
  });

  it("treats expired entries as unknown before account or chat mismatches", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-08T00:00:00Z"));
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "expired-guid",
      chatId: 42,
      timestamp: Date.now(),
    });
    vi.setSystemTime(new Date("2026-05-08T07:00:00Z"));

    expect(
      await resolveIMessageCachedResourceBinding("expired-guid", {
        accountId: "other",
        chatId: 99,
      }),
    ).toBe("unknown");
  });

  it("matches a trusted current message through its chat identifier", async () => {
    const chatContext = { chatIdentifier: "+12069106512" };
    const entry = await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "current-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 42,
      timestamp: Date.now(),
    });

    expect(
      await isIMessageCurrentMessageInChatAsync({
        accountId: "work",
        currentMessageId: entry.shortId,
        chatContext,
      }),
    ).toBe(true);
    expect(
      await isIMessageCurrentMessageInChatAsync({
        accountId: "work",
        currentMessageId: "current-guid",
        chatContext,
      }),
    ).toBe(true);
  });

  it("fails closed for wrong accounts, chats, and unknown current messages", async () => {
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "current-guid",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      chatId: 42,
      timestamp: Date.now(),
    });

    expect(
      await isIMessageCurrentMessageInChatAsync({
        accountId: "other",
        currentMessageId: "current-guid",
        chatContext: { chatId: 42 },
      }),
    ).toBe(false);
    expect(
      await isIMessageCurrentMessageInChatAsync({
        accountId: "work",
        currentMessageId: "current-guid",
        chatContext: { chatId: 99 },
      }),
    ).toBe(false);
    expect(
      await isIMessageCurrentMessageInChatAsync({
        accountId: "work",
        currentMessageId: "unknown-guid",
        chatContext: { chatId: 42 },
      }),
    ).toBe(false);
  });
});
