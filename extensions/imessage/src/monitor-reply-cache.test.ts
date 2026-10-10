// Imessage tests cover monitor reply cache plugin behavior.
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
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
let isIMessageCurrentMessageInChat: ReplyCacheModule["isIMessageCurrentMessageInChat"];
let isKnownFromMeIMessageMessageId: ReplyCacheModule["isKnownFromMeIMessageMessageId"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let resolveIMessageCachedResourceBinding: ReplyCacheModule["resolveIMessageCachedResourceBinding"];
let resolveIMessageMessageId: ReplyCacheModule["resolveIMessageMessageId"];

async function loadReplyCache(options?: { preservePersistentState?: boolean }): Promise<void> {
  ({
    findLatestIMessageEntryForChat,
    isIMessageCurrentMessageInChat,
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
  it("resolves a short id to a cached message guid", async () => {
    const entry = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(entry.shortId).toBe("1");
    expect(
      await resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).toBe("full-guid");
  });

  it("resolves a known short id even without caller-supplied chat scope", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    // The cached entry already carries chat info; cross-chat checks only
    // matter when the caller separately provides a (potentially conflicting)
    // chat scope. A plain known short id from the cache must resolve.
    expect(await resolveIMessageMessageId("1", { requireKnownShortId: true })).toBe("full-guid");
  });

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

  it("rejects an uncached full guid under requireFromMe (agent cannot edit/unsend unknown messages)", async () => {
    await expect(
      resolveIMessageMessageId("never-seen-guid", {
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).rejects.toThrow("not one this agent sent");
  });

  it("rejects when the cached entry has no isFromMe field (older persisted entry, treated as not-from-me)", async () => {
    // Persisted entries written before this option existed do not carry
    // isFromMe. Treat undefined as the safe default (false) — that pre-
    // existing-on-disk caller is the inbound recorder, the only writer that
    // existed before.
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "legacy-guid",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      // isFromMe deliberately omitted
    });

    await expect(
      resolveIMessageMessageId("legacy-guid", {
        chatContext: { chatGuid: "iMessage;+;chatA" },
        requireFromMe: true,
      }),
    ).rejects.toThrow("not one this agent sent");
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

  it("matches across chat-id-format flavors (iMessage;-;<phone>, any;-;<phone>, bare phone)", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "phone-msg",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    for (const ctx of [
      { accountId: "default", chatIdentifier: "iMessage;-;+12069106512" },
      { accountId: "default", chatIdentifier: "SMS;-;+12069106512" },
      { accountId: "default", chatGuid: "any;-;+12069106512" },
      { accountId: "default", chatIdentifier: "+12069106512" },
    ]) {
      const found = findLatestIMessageEntryForChat(ctx);
      expect(found?.messageId).toBe("phone-msg");
    }
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
  it("retains the durable short-id counter when entry hydration fails", async () => {
    createIMessagePluginStateSyncStoreForTest<{ counter: number }>({
      namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
      maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
    }).register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, { counter: 40 });
    const { getIMessageRuntime } = await import("./runtime.js");
    const state = getIMessageRuntime().state;
    const openKeyedStore = state.openKeyedStore;
    const open = vi
      .spyOn(state, "openKeyedStore")
      .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = openKeyedStore<T>(options);
        if (options.namespace === IMESSAGE_REPLY_CACHE_NAMESPACE) {
          vi.spyOn(store, "entries").mockRejectedValue(new Error("entry read unavailable"));
        }
        return store;
      });
    try {
      const entry = await rememberIMessageReplyCache({
        accountId: "default",
        messageId: "after-read-failure",
        timestamp: Date.now(),
      });
      expect(entry.shortId).toBe("41");
    } finally {
      open.mockRestore();
    }
  });

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

  it("hydrates SQLite state before resolving a short id whose mapping predates this run", async () => {
    // Issue-then-restart contract: a shortId we issued before a gateway
    // restart must still resolve afterwards. The first resolve call after
    // process boot would otherwise miss the persisted mapping because the
    // in-memory maps haven't been hydrated yet — that's the bug codex
    // review flagged. resolveIMessageMessageId now hydrates on entry.
    const issued = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "outbound-guid-pre-restart",
      chatGuid: "iMessage;+;chatA",
      timestamp: Date.now(),
      isFromMe: true,
    });
    expect(issued.shortId).not.toBe("");

    // Simulate a restart: clear only the process-local maps and leave the
    // SQLite plugin-state rows intact.
    await loadReplyCache({ preservePersistentState: true });

    // Now resolve the short id we issued before the "restart". Without the
    // hydrate-on-resolve fix this throws "no longer available" because the
    // in-memory maps are empty and rememberIMessageReplyCache hasn't been
    // called yet to trigger hydration.
    expect(
      await resolveIMessageMessageId(issued.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chatA" },
      }),
    ).toBe("outbound-guid-pre-restart");
  });

  it("persists entries when optional chat fields are explicitly undefined", async () => {
    const issued = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "guid-with-undefined-optionals",
      chatGuid: undefined,
      chatIdentifier: undefined,
      chatId: undefined,
      timestamp: Date.now(),
    });

    await loadReplyCache({ preservePersistentState: true });

    expect(
      await resolveIMessageMessageId(issued.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+15551234567" },
      }),
    ).toBe("guid-with-undefined-optionals");
  });

  it.each([
    { name: "missing", counter: undefined },
    { name: "lagging", counter: 6 },
  ])(
    "allocates above live SQLite short ids with a $name counter after reload",
    async ({ counter }) => {
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
      if (counter !== undefined) {
        createIMessagePluginStateSyncStoreForTest<{ counter: number }>({
          namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
          maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
        }).register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, { counter });
      }

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
    },
  );

  it("does not reuse short ids after cached rows expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-08T00:00:00Z"));
    const first = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "old-guid",
      timestamp: Date.now(),
    });
    expect(first.shortId).toBe("1");

    vi.setSystemTime(new Date("2026-05-08T07:00:00Z"));
    await loadReplyCache({ preservePersistentState: true });
    const second = await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "new-guid",
      timestamp: Date.now(),
    });

    expect(second.shortId).toBe("2");
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

  it.each([{ chatGuid: "any;-;+12069106512" }, { chatIdentifier: "+12069106512" }, { chatId: 42 }])(
    "matches a trusted current message through $chatGuid$chatIdentifier$chatId",
    async (chatContext) => {
      const entry = await rememberIMessageReplyCache({
        accountId: "work",
        messageId: "current-guid",
        chatGuid: "any;-;+12069106512",
        chatIdentifier: "+12069106512",
        chatId: 42,
        timestamp: Date.now(),
      });

      expect(
        isIMessageCurrentMessageInChat({
          accountId: "work",
          currentMessageId: entry.shortId,
          chatContext,
        }),
      ).toBe(true);
      expect(
        isIMessageCurrentMessageInChat({
          accountId: "work",
          currentMessageId: "current-guid",
          chatContext,
        }),
      ).toBe(true);
    },
  );

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
      isIMessageCurrentMessageInChat({
        accountId: "other",
        currentMessageId: "current-guid",
        chatContext: { chatId: 42 },
      }),
    ).toBe(false);
    expect(
      isIMessageCurrentMessageInChat({
        accountId: "work",
        currentMessageId: "current-guid",
        chatContext: { chatId: 99 },
      }),
    ).toBe(false);
    expect(
      isIMessageCurrentMessageInChat({
        accountId: "work",
        currentMessageId: "unknown-guid",
        chatContext: { chatId: 42 },
      }),
    ).toBe(false);
  });
});
