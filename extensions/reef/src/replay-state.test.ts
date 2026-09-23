import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64url, generateIdentity, signReceipt } from "../protocol/index.js";
import {
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefReplayStoreKey,
  type ReefReplayRecord,
} from "./replay-store.js";
import { openStores } from "./state.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const id = "01JZ0000000000000000000000";
const hash = "a".repeat(64);
const key = reefReplayStoreKey("alice", id);

function fixture(
  host: "worker" | "no-observe" | "no-compare" = "worker",
  maxEntries = REEF_REPLAY_MAX_ENTRIES,
) {
  const stateDir = temp.make("reef-replay-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const runtime = createPluginRuntimeMock();
  const options = {
    namespace: REEF_REPLAY_NAMESPACE,
    maxEntries,
    overflowPolicy: "reject-new" as const,
    defaultTtlMs: REEF_REPLAY_TTL_MS,
    env,
  };
  const store = createPluginStateKeyedStoreForTests<ReefReplayRecord>("reef", options);
  const raw = createPluginStateSyncKeyedStoreForTests<ReefReplayRecord>("reef", options);
  runtime.state.openSyncKeyedStore = <T>(opts: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", { ...opts, env });
  runtime.state.openKeyedStore = <T>(opts: OpenAsyncKeyedStoreOptions) => {
    if (opts.retention === "retained" || opts.namespace !== REEF_REPLAY_NAMESPACE) {
      return createPluginStateKeyedStoreForTests<T>("reef", { ...opts, env });
    }
    const adapter = {
      ...store,
      ...(host === "no-observe" ? { observe: undefined } : {}),
      ...(host === "no-compare" ? { compareAndApply: undefined } : {}),
    };
    // The runtime's generic namespace selects this fixture's ReefReplayRecord store.
    return adapter as PluginStateKeyedStore<T>;
  };
  const identity = generateIdentity();
  const keys = {
    ...identity,
    keyEpoch: 1,
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
  };
  const open = () => openStores(runtime, keys, { replayMaxEntries: maxEntries }).replay;
  const receipt = signReceipt(
    { id, bodyHash: "b".repeat(64), auditHead: "c".repeat(64), status: "accepted" },
    identity.signing.secretKey,
  );
  return { store, raw, runtime, open, receipt, env };
}

describe("Reef replay worker ownership", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it("claims, refreshes, completes and reopens encrypted replay without host SQLite calls", async () => {
    const f = fixture();
    const replay = f.open();
    const observation = observeHostDataSql(f.env);
    const sql = observation.calls;
    await expect(replay.claim("alice", id, hash)).resolves.toBe("new");
    await replay.refresh?.("alice", id);
    await replay.complete("alice", id, f.receipt, { text: "synthetic private body" });
    await expect(replay.claim("alice", id, hash)).resolves.toBe("duplicate");
    await expect(replay.completed("alice", id)).resolves.toEqual({
      receipt: f.receipt,
      body: { text: "synthetic private body" },
    });
    await expect(replay.claim("alice", id, "different")).resolves.toBe("mismatch");
    for (const spy of sql) {
      expect(spy).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    await expect(f.open().completed("alice", id)).resolves.toEqual({
      receipt: f.receipt,
      body: { text: "synthetic private body" },
    });
    expect(JSON.stringify(f.raw.lookup(key))).not.toContain("synthetic private body");
  });

  it.each(["no-observe", "no-compare"] as const)(
    "retains atomic native publication when %s",
    async (host) => {
      const f = fixture(host);
      const comparisons = vi.spyOn(f.store, "compareAndApply");
      const replay = f.open();
      const claim = replay.claim("alice", id, hash);
      expect(f.raw.lookup(key)?.state).toBe("in_flight");
      const consume = replay.consume("alice", id);
      expect(f.raw.lookup(key)?.state).toBe("consumed");
      await expect(claim).resolves.toBe("new");
      await consume;
      expect(comparisons).not.toHaveBeenCalled();
    },
  );

  it("preserves invocation order through delayed claim publication and successor ownership", async () => {
    const f = fixture();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const compare = f.store.compareAndApply!;
    let calls = 0;
    f.store.compareAndApply = async (...args) => {
      if (++calls === 1) {
        started.resolve();
        await finish.promise;
      }
      return compare(...args);
    };
    const replay = f.open();
    const first = replay.claim("alice", id, hash);
    await started.promise;
    const release = replay.release("alice", id);
    const next = replay.claim("alice", id, hash);
    const refresh = replay.refresh!("alice", id);
    await Promise.resolve();
    expect(calls).toBe(1);
    finish.resolve();
    await expect(first).resolves.toBe("new");
    await release;
    await expect(next).resolves.toBe("new");
    await refresh;
    await replay.consume("alice", id);
    expect(f.raw.lookup(key)?.state).toBe("consumed");
  });

  it.each(["refresh", "complete", "consume", "release"] as const)(
    "retains a matching owner after lease expiry for %s",
    async (operation) => {
      const f = fixture();
      const replay = f.open();
      await replay.claim("alice", id, hash);
      await f.store.register(key, { ...f.raw.lookup(key)!, claimExpiresAt: Date.now() - 1 });
      if (operation === "complete") {
        await replay.complete("alice", id, f.receipt, { text: "body" });
      } else {
        await replay[operation]!("alice", id);
      }
      expect(f.raw.lookup(key)?.state).toBe(
        { refresh: "in_flight", complete: "completed", consume: "consumed", release: "available" }[
          operation
        ],
      );
    },
  );

  it("rejects stale completion and cleanup after a conflicting successor takes ownership", async () => {
    const f = fixture();
    const original = f.open();
    await original.claim("alice", id, hash);
    const successor = f.open();
    const compare = f.store.compareAndApply!;
    let takeover = true;
    f.store.compareAndApply = async (...args) => {
      if (takeover) {
        takeover = false;
        await f.store.register(key, { ...f.raw.lookup(key)!, claimExpiresAt: Date.now() - 1 });
        await successor.claim("alice", id, hash);
      }
      return compare(...args);
    };
    // A fresh handle captures the instrumented worker method but owns its own claim.
    const stale = f.open();
    await f.store.register(key, { ...f.raw.lookup(key)!, claimExpiresAt: Date.now() - 1 });
    takeover = false;
    await stale.claim("alice", id, hash);
    takeover = true;
    await expect(stale.complete("alice", id, f.receipt, { text: "stale" })).rejects.toThrow(
      "replay claim is not in flight",
    );
    const owner = f.raw.lookup(key)?.claimOwner;
    await expect(stale.consume("alice", id)).rejects.toThrow("replay claim is not in flight");
    await expect(stale.refresh!("alice", id)).rejects.toThrow("replay claim is not in flight");
    await stale.release("alice", id);
    expect(f.raw.lookup(key)?.claimOwner).toBe(owner);
    await successor.refresh!("alice", id);
    await successor.complete("alice", id, f.receipt, { text: "successor" });
    await expect(successor.completed("alice", id)).resolves.toMatchObject({
      body: { text: "successor" },
    });
  });

  it("rechecks lease eligibility after a conflict without regenerating the claim candidate", async () => {
    const f = fixture();
    const now = Date.now();
    const deadline = now + 50_000;
    await f.store.register(key, {
      peer: "alice",
      id,
      envelopeHash: hash,
      state: "in_flight",
      claimOwner: "previous",
      claimExpiresAt: deadline,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const compare = f.store.compareAndApply!;
    let changed = false;
    f.store.compareAndApply = async (...args) => {
      if (!changed) {
        changed = true;
        expect(args[2]).toMatchObject({ action: "set", value: { claimOwner: "previous" } });
        await f.store.register(key, { ...f.raw.lookup(key)!, claimExpiresAt: deadline + 1 });
        clock.mockReturnValue(deadline + 2);
      }
      return compare(...args);
    };
    const replay = f.open();
    await expect(replay.claim("alice", id, hash)).resolves.toBe("new");
    expect(f.raw.lookup(key)?.claimExpiresAt).toBe(now + 5 * 60_000);
    await replay.consume("alice", id);
  });

  it("revalidates a repaired row before exposing a prepared validation error", async () => {
    const f = fixture();
    const valid: ReefReplayRecord = {
      peer: "alice",
      id,
      envelopeHash: hash,
      state: "in_flight",
      claimOwner: "existing",
      claimExpiresAt: Date.now() + 60_000,
    };
    await f.store.register(key, { ...valid, claimOwner: "" });
    const compare = f.store.compareAndApply!;
    let repaired = false;
    f.store.compareAndApply = async (...args) => {
      if (!repaired) {
        repaired = true;
        expect(args[2]).toEqual({ operation: "delete", action: "keep" });
        await f.store.register(key, valid);
      }
      return compare(...args);
    };
    await expect(f.open().claim("alice", id, hash)).resolves.toBe("in_flight");
    expect(f.raw.lookup(key)).toEqual(valid);
  });

  it("prepares a failing nonce once across a conflict and preserves the current claim", async () => {
    const f = fixture();
    const compare = f.store.compareAndApply!;
    let changed = false;
    f.store.compareAndApply = async (...args) => {
      if (!changed && args[2].operation === "delete") {
        changed = true;
        const current = f.raw.lookup(key)!;
        await f.store.register(key, { ...current, claimExpiresAt: current.claimExpiresAt! + 1 });
      }
      return compare(...args);
    };
    const replay = f.open();
    await replay.claim("alice", id, hash);
    const failure = new Error("synthetic nonce preparation failure");
    const rng = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw failure;
    });
    await expect(replay.complete("alice", id, f.receipt, { text: "body" })).rejects.toBe(failure);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(f.raw.lookup(key)?.state).toBe("in_flight");
    rng.mockRestore();
    await replay.consume("alice", id);
  });

  it("freezes caller input and encrypted bytes across a renewal conflict", async () => {
    const f = fixture();
    const compare = f.store.compareAndApply!;
    const ciphertexts: string[] = [];
    f.store.compareAndApply = async (entryKey, comparison, intent) => {
      if (intent.action === "set" && intent.value.state === "completed") {
        ciphertexts.push(intent.value.body!.enc);
        if (ciphertexts.length === 1) {
          const current = f.raw.lookup(entryKey)!;
          await f.store.register(entryKey, {
            ...current,
            claimExpiresAt: current.claimExpiresAt! + 1,
          });
        }
      }
      return compare(entryKey, comparison, intent);
    };
    const replay = f.open();
    await replay.claim("alice", id, hash);
    const rng = vi.spyOn(globalThis.crypto, "getRandomValues");
    const receipt = structuredClone(f.receipt);
    const body = { text: "original" };
    const complete = replay.complete("alice", id, receipt, body);
    receipt.bodyHash = "changed";
    body.text = "changed";
    await complete;
    expect(ciphertexts).toHaveLength(2);
    expect(new Set(ciphertexts).size).toBe(1);
    expect(rng).toHaveBeenCalledTimes(1);
    await expect(replay.completed("alice", id)).resolves.toEqual({
      receipt: f.receipt,
      body: { text: "original" },
    });
  });

  it.each([
    "mismatch",
    "duplicate",
    "in_flight",
    "refresh",
    "complete",
    "consume",
    "release",
  ] as const)("renews existing-row retention on %s refusal", async (operation) => {
    const f = fixture();
    const replay = f.open();
    await replay.claim("alice", id, hash);
    const state = operation === "duplicate" ? "consumed" : "in_flight";
    await f.store.register(
      key,
      { ...f.raw.lookup(key)!, state, claimOwner: "successor" },
      { ttlMs: 1_000 },
    );
    const before = f.raw.entries()[0]!.expiresAt!;
    if (operation === "mismatch" || operation === "duplicate" || operation === "in_flight") {
      await expect(
        replay.claim("alice", id, operation === "mismatch" ? "other" : hash),
      ).resolves.toBe(operation);
    } else if (operation === "release") {
      await replay.release("alice", id);
    } else {
      await expect(
        operation === "complete"
          ? replay.complete("alice", id, f.receipt, { text: "body" })
          : replay[operation]!("alice", id),
      ).rejects.toThrow("replay claim is not in flight");
    }
    const after = f.raw.entries()[0]!;
    expect(after.expiresAt! - before).toBeGreaterThan(REEF_REPLAY_TTL_MS - 2_000);
    expect(after.value.claimOwner).toBe("successor");
  });

  it.each(["worker", "no-compare"] as const)(
    "preserves validation placement and native diagnostics on %s",
    async (host) => {
      const f = fixture(host);
      const replay = f.open();
      const rng = vi.spyOn(globalThis.crypto, "getRandomValues");
      await expect(
        replay.complete("alice", id, { ...f.receipt, id: "wrong" }, { text: "body" }),
      ).rejects.toThrow("receipt id does not match");
      await expect(replay.complete("alice", id, f.receipt)).rejects.toThrow("requires body");
      await expect(
        replay.complete("alice", id, f.receipt, { text: "body", thread: "invalid" }),
      ).rejects.toThrow("replay claim is not in flight");
      expect(rng).not.toHaveBeenCalled();
      await replay.claim("alice", id, hash);
      await expect(
        replay.complete("alice", id, f.receipt, { text: "body", thread: "invalid" }),
      ).rejects.toThrow(
        host === "worker" ? "invalid body identifier" : "Failed to update plugin state entry",
      );
      expect(rng).not.toHaveBeenCalled();
      await replay.complete("alice", id, f.receipt, { text: "valid" });
      expect(rng).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["observe", "compareAndApply"] as const)(
    "does not fall back after %s fails",
    async (method) => {
      const f = fixture();
      const failure = new Error("synthetic worker refusal");
      vi.spyOn(f.store, method).mockRejectedValue(failure);
      const native = vi.spyOn(f.runtime.state, "openSyncKeyedStore");
      const replay = f.open();
      native.mockClear();
      await expect(replay.claim("alice", id, hash)).rejects.toBe(failure);
      expect(native).not.toHaveBeenCalled();
      expect(f.raw.lookup(key)).toBeUndefined();
    },
  );

  it("does not evict retained bindings at capacity and admits queued work after a failure", async () => {
    const f = fixture("worker", 1);
    const replay = f.open();
    await replay.claim("alice", id, hash);
    await replay.consume("alice", id);
    await expect(replay.claim("alice", "second", hash)).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expect(replay.claim("alice", id, hash)).resolves.toBe("duplicate");
    expect(f.raw.entries()).toHaveLength(1);
  });
});
