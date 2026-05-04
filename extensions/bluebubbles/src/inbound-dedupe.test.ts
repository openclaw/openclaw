import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBlueBubblesInboundDedupForTest,
  claimBlueBubblesInboundMessage,
  commitBlueBubblesCoalescedMessageIds,
  resolveBlueBubblesInboundDedupeKey,
} from "./inbound-dedupe.js";
import type { PluginRuntime } from "./runtime-api.js";
import { clearBlueBubblesRuntime, setBlueBubblesRuntime } from "./runtime.js";

const SQLITE_CLAIM_LEASE_MS = 30 * 60 * 1_000;

type RuntimeStateRecord = { status: "claimed" | "committed"; at: number };

type RuntimeStateEntry = {
  value: RuntimeStateRecord;
  expiresAt?: number;
};

type RuntimeStateStore = {
  register: (key: string, value: RuntimeStateRecord, opts?: { ttlMs?: number }) => Promise<void>;
  registerIfAbsent: (
    key: string,
    value: RuntimeStateRecord,
    opts?: { ttlMs?: number },
  ) => Promise<boolean>;
  lookup: (key: string) => Promise<RuntimeStateRecord | undefined>;
  delete: (key: string) => Promise<boolean>;
  entries: () => Promise<unknown[]>;
  clear: () => Promise<void>;
};

function createMemoryRuntimeStateStore(): RuntimeStateStore {
  const entries = new Map<string, RuntimeStateEntry>();

  function isExpired(entry: RuntimeStateEntry | undefined): boolean {
    return entry?.expiresAt != null && entry.expiresAt <= Date.now();
  }

  function pruneExpired(key: string): void {
    if (isExpired(entries.get(key))) {
      entries.delete(key);
    }
  }

  function buildEntry(value: RuntimeStateRecord, opts?: { ttlMs?: number }): RuntimeStateEntry {
    return { value, ...(opts?.ttlMs != null ? { expiresAt: Date.now() + opts.ttlMs } : {}) };
  }

  return {
    async register(key, value, opts) {
      entries.set(key, buildEntry(value, opts));
    },
    async registerIfAbsent(key, value, opts) {
      pruneExpired(key);
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, buildEntry(value, opts));
      return true;
    },
    async lookup(key) {
      pruneExpired(key);
      return entries.get(key)?.value;
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries.entries()];
    },
    async clear() {
      entries.clear();
    },
  };
}

function installRuntimeStateStub(enabled: boolean, store = createMemoryRuntimeStateStore()) {
  const openKeyedStore = vi.fn(() => store);
  setBlueBubblesRuntime({
    config: {
      current: () => ({
        plugins: {
          entries: {
            bluebubbles: {
              config: { experimentalPersistentState: enabled },
            },
          },
        },
      }),
    },
    state: { openKeyedStore },
  } as unknown as PluginRuntime);
  return { openKeyedStore, store };
}

async function claimAndFinalize(guid: string | undefined, accountId: string): Promise<string> {
  const claim = await claimBlueBubblesInboundMessage({ guid, accountId });
  if (claim.kind === "claimed") {
    await claim.finalize();
  }
  return claim.kind;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("claimBlueBubblesInboundMessage", () => {
  beforeEach(() => {
    clearBlueBubblesRuntime();
    _resetBlueBubblesInboundDedupForTest();
  });

  it("claims a new guid and rejects committed duplicates", async () => {
    expect(await claimAndFinalize("g1", "acc")).toBe("claimed");
    expect(await claimAndFinalize("g1", "acc")).toBe("duplicate");
  });

  it("keeps file-backed dedupe as the default when persistent state is not opted in", async () => {
    const { openKeyedStore } = installRuntimeStateStub(false);

    expect(await claimAndFinalize("g-default", "acc")).toBe("claimed");
    expect(await claimAndFinalize("g-default", "acc")).toBe("duplicate");
    expect(openKeyedStore).not.toHaveBeenCalled();
  });

  it("uses runtime state registerIfAbsent when persistent state is opted in", async () => {
    const { openKeyedStore, store } = installRuntimeStateStub(true);
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent");

    const first = await claimBlueBubblesInboundMessage({ guid: "g-sqlite", accountId: "acc" });
    expect(first.kind).toBe("claimed");
    const second = await claimBlueBubblesInboundMessage({ guid: "g-sqlite", accountId: "acc" });
    expect(second.kind).toBe("inflight");
    if (first.kind === "claimed") {
      await first.finalize();
    }

    expect(
      (await claimBlueBubblesInboundMessage({ guid: "g-sqlite", accountId: "acc" })).kind,
    ).toBe("duplicate");
    expect(openKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: expect.stringMatching(/^inbound-dedupe\./),
        maxEntries: 50_000,
        maxPluginEntries: 50_000,
      }),
    );
    expect(registerIfAbsent).toHaveBeenCalledWith(
      "g-sqlite",
      expect.objectContaining({ status: "claimed" }),
      { ttlMs: SQLITE_CLAIM_LEASE_MS },
    );
  });

  it("reports a fresh opted-in runtime state claim as inflight", async () => {
    const { store } = installRuntimeStateStub(true);
    await store.register(
      "g-fresh-claim",
      { status: "claimed", at: Date.now() },
      { ttlMs: SQLITE_CLAIM_LEASE_MS },
    );

    expect(
      (await claimBlueBubblesInboundMessage({ guid: "g-fresh-claim", accountId: "acc" })).kind,
    ).toBe("inflight");
  });

  it("reclaims expired opted-in runtime state claims after a simulated crash", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { store } = installRuntimeStateStub(true);

    const first = await claimBlueBubblesInboundMessage({ guid: "g-stale-claim", accountId: "acc" });
    expect(first.kind).toBe("claimed");

    _resetBlueBubblesInboundDedupForTest();
    vi.setSystemTime(1_000 + SQLITE_CLAIM_LEASE_MS + 1);

    const replay = await claimBlueBubblesInboundMessage({
      guid: "g-stale-claim",
      accountId: "acc",
    });
    expect(replay.kind).toBe("claimed");
    if (replay.kind === "claimed") {
      await replay.finalize();
    }
    await expect(store.lookup("g-stale-claim")).resolves.toMatchObject({ status: "committed" });
  });

  it("releases opted-in runtime state claims so later replays can retry", async () => {
    installRuntimeStateStub(true);

    const first = await claimBlueBubblesInboundMessage({ guid: "g-release", accountId: "acc" });
    expect(first.kind).toBe("claimed");
    if (first.kind === "claimed") {
      first.release();
    }
    expect(
      (await claimBlueBubblesInboundMessage({ guid: "g-release", accountId: "acc" })).kind,
    ).toBe("claimed");
  });

  it("scopes dedupe per account", async () => {
    expect(await claimAndFinalize("g1", "a")).toBe("claimed");
    expect(await claimAndFinalize("g1", "b")).toBe("claimed");
  });

  it("reports skip when guid is missing or blank", async () => {
    expect((await claimBlueBubblesInboundMessage({ guid: undefined, accountId: "acc" })).kind).toBe(
      "skip",
    );
    expect((await claimBlueBubblesInboundMessage({ guid: "", accountId: "acc" })).kind).toBe(
      "skip",
    );
    expect((await claimBlueBubblesInboundMessage({ guid: "   ", accountId: "acc" })).kind).toBe(
      "skip",
    );
  });

  it("rejects overlong guids to cap on-disk size", async () => {
    const huge = "x".repeat(10_000);
    expect((await claimBlueBubblesInboundMessage({ guid: huge, accountId: "acc" })).kind).toBe(
      "skip",
    );
  });

  it("releases the claim so a later replay can retry after a transient failure", async () => {
    const first = await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "acc" });
    expect(first.kind).toBe("claimed");
    if (first.kind === "claimed") {
      first.release();
    }
    // Released claims should be re-claimable on the next delivery.
    expect(await claimAndFinalize("g1", "acc")).toBe("claimed");
  });
});

describe("commitBlueBubblesCoalescedMessageIds", () => {
  beforeEach(() => {
    clearBlueBubblesRuntime();
    _resetBlueBubblesInboundDedupForTest();
  });

  it("marks every coalesced source messageId as seen so a later replay dedupes", async () => {
    // Primary was processed via claim+finalize by the debouncer flush.
    expect(await claimAndFinalize("primary", "acc")).toBe("claimed");
    // Secondaries reach dedupe through the bulk-commit path.
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["secondary-1", "secondary-2"],
      accountId: "acc",
    });
    // A MessagePoller replay of any individual source event is now a duplicate
    // rather than a fresh agent turn — the core bug this helper exists to fix.
    expect(await claimAndFinalize("primary", "acc")).toBe("duplicate");
    expect(await claimAndFinalize("secondary-1", "acc")).toBe("duplicate");
    expect(await claimAndFinalize("secondary-2", "acc")).toBe("duplicate");
  });

  it("scopes coalesced commits per account", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["g1"],
      accountId: "a",
    });
    // Same messageId under a different account is still claimable.
    expect(await claimAndFinalize("g1", "a")).toBe("duplicate");
    expect(await claimAndFinalize("g1", "b")).toBe("claimed");
  });

  it("skips empty or overlong guids without throwing", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["", "   ", "x".repeat(10_000), "valid"],
      accountId: "acc",
    });
    expect(await claimAndFinalize("valid", "acc")).toBe("duplicate");
    // Overlong guid was skipped by sanitization, not committed.
    expect(await claimAndFinalize("x".repeat(10_000), "acc")).toBe("skip");
  });
});

describe("resolveBlueBubblesInboundDedupeKey", () => {
  it("returns messageId for new-message events", () => {
    expect(resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" })).toBe("msg-1");
  });

  it("returns associatedMessageGuid for balloon events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({
        messageId: "balloon-1",
        balloonBundleId: "com.apple.messages.URLBalloonProvider",
        associatedMessageGuid: "msg-1",
      }),
    ).toBe("msg-1");
  });

  it("suffixes key with :updated for updated-message events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1", eventType: "updated-message" }),
    ).toBe("msg-1:updated");
  });

  it("updated-message and new-message for same GUID produce distinct keys", () => {
    const newKey = resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" });
    const updatedKey = resolveBlueBubblesInboundDedupeKey({
      messageId: "msg-1",
      eventType: "updated-message",
    });
    expect(newKey).not.toBe(updatedKey);
  });

  it("returns undefined when messageId is missing", () => {
    expect(resolveBlueBubblesInboundDedupeKey({})).toBeUndefined();
  });
});
