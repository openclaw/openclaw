import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import {
  base64url,
  generateIdentity,
  signReceipt,
  verifyChain,
  verifyChainSegment,
  type ReviewRequest,
} from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { handleReefCommand } from "./commands.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefMessageFlow } from "./flow.js";
import { ReefFriendManager } from "./friends.js";
import { REEF_REPLAY_TTL_MS, reefReplayStoreKey } from "./replay-store.js";
import { createReefRuntimeAuthority } from "./runtime.js";
import {
  assertReefIdentityBinding,
  clearReefSetupSession,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  loadReefSetupSession,
  openStores,
  finalizeReefIdentityBinding,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  ReefDeliveredStore,
  ReefInboxCursorStore,
  REEF_DELIVERED_TTL_MS,
  REEF_REVIEWS_NAMESPACE,
  releaseReefIdentityReservation,
  reserveReefIdentityBinding,
  ReviewApprovalStore,
  saveReefSetupSession,
} from "./state.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

const auditKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const replayKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const receiptId = "01JZ0000000000000000000000";

function reefKeys() {
  return { ...generateIdentity(), auditKey, replayKey, keyEpoch: 1 };
}

function reviewRequest(id = receiptId, approvalDigest = "b".repeat(64)): ReviewRequest {
  return {
    id,
    from: "alice#1",
    to: "bob#1",
    direction: "outbound",
    bodyHash: "a".repeat(64),
    approvalDigest,
    verdict: {
      decision: "review",
      category: "ambiguous",
      reason: "Owner review.",
      model: "test-model",
      policyVersion: "v1",
    },
  };
}

function createRuntime(stateDir: string, registrationHost: "worker" | "legacy" = "worker") {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    if (registrationHost === "legacy") {
      const { observe: _observe, compareAndApply: _compareAndApply, ...legacy } = store;
      return legacy;
    }
    return store;
  };
  return runtime;
}

function registerReviewListCommand() {
  const api = createTestPluginApi({ registrationMode: "tool-discovery" });
  const registerCommand = vi.spyOn(api, "registerCommand");
  reefChannelEntry.register(api);
  expect(registerCommand).toHaveBeenCalledOnce();
  const command = registerCommand.mock.calls[0]![0];
  return async () =>
    await command.handler({
      args: "review list",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/reef review list",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });
}

function activateReviewStore(
  authority: ReturnType<typeof createReefRuntimeAuthority>,
  runtime: ReturnType<typeof createRuntime>,
  reviews: ReviewApprovalStore,
) {
  const config = ReefChannelConfigSchema.parse({ handle: "bob" });
  const keys = { ...generateIdentity(), auditKey, replayKey, keyEpoch: 1 };
  const transport = new ReefTransportClient(config.relayUrl, "bob", keys, async () => {
    throw new Error("Unexpected relay request during review listing");
  });
  const trust = openReefTrustStore(runtime, config);
  authority.activate({
    reviews,
    friends: new ReefFriendManager(transport, trust, {
      list: async () => [],
      remove: async () => false,
    }),
    flow: new ReefMessageFlow({
      config,
      keys,
      transport,
      trust,
      reviews,
      delivered: new ReefDeliveredStore(runtime),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(1)),
      replay: new MemoryReplayStore(),
      guard: {
        providerId: "test",
        pinnedModel: "test-model",
        classify: async () => {
          throw new Error("Unexpected guard classification during review listing");
        },
      },
      onIngress: async () => {},
      onOwnerNotice: async () => {},
    }),
  });
}

async function bindIdentity(
  runtime: ReturnType<typeof createRuntime>,
  handle: string,
): Promise<void> {
  await finalizeReefIdentityBinding(
    runtime,
    await reserveReefIdentityBinding(runtime, { handle, relayUrl: "https://reefwire.ai" }),
  );
}

describe("Reef SQLite state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Drain worker admissions before deleting files whose physical identity can be reused.
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists a monotonic inbox cursor for the bound Reef identity", async () => {
    const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
    const store = new ReefInboxCursorStore(createRuntime(stateDir), binding);

    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);

    expect(await new ReefInboxCursorStore(createRuntime(stateDir), binding).load()).toBe(12);
    await expect(
      new ReefInboxCursorStore(createRuntime(stateDir), {
        handle: "clawd",
        relayUrl: "https://reefwire.ai",
      }).load(),
    ).rejects.toThrow("different identity");
  });

  it("does not let an expired audit writer replace a committed successor link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const keys = reefKeys();
    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "initial",
      { id: 1 },
      10,
    );
    const competing = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    let triggerCompetingWriter = true;
    let competingAppend: Promise<unknown> | undefined;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        registerIfAbsent(key, value, opts) {
          const inserted = store.registerIfAbsent(key, value, opts);
          if (triggerCompetingWriter && inserted) {
            triggerCompetingWriter = false;
            vi.advanceTimersByTime(31_000);
            competingAppend = competing.appendEvent("winner", { id: 2 }, 12);
          }
          return inserted;
        },
      };
    };

    const expired = openStores(runtime, keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "expired",
      { id: 3 },
      11,
    );
    await expect(expired).rejects.toThrow();
    await expect(competingAppend).resolves.toBeDefined();
    const retained = await competing.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["initial", "winner"]);
  });

  it("retains expired audit cleanup state when takeover cleanup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const keys = reefKeys();
    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "initial",
      { id: 1 },
      10,
    );

    const takeoverRuntime = createRuntime(stateDir);
    const takeoverOpenStore = takeoverRuntime.state.openSyncKeyedStore;
    let failCleanup = true;
    takeoverRuntime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = takeoverOpenStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        delete(key) {
          const deleted = store.delete(key);
          if (failCleanup) {
            failCleanup = false;
            throw new Error("simulated cleanup interruption");
          }
          return deleted;
        },
      };
    };
    const takeover = openStores(takeoverRuntime, keys, { auditMaxEntries: 2 }).audit;
    const stalledRuntime = createRuntime(stateDir);
    const stalledOpenStore = stalledRuntime.state.openSyncKeyedStore;
    let takeoverAppend: Promise<unknown> | undefined;
    stalledRuntime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = stalledOpenStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        registerIfAbsent(key, value, opts) {
          const inserted = store.registerIfAbsent(key, value, opts);
          if (inserted && !takeoverAppend) {
            vi.advanceTimersByTime(31_000);
            takeoverAppend = takeover.appendEvent("interrupted-takeover", { id: 2 }, 12);
          }
          return inserted;
        },
      };
    };

    await expect(
      openStores(stalledRuntime, keys, { auditMaxEntries: 2 }).audit.appendEvent(
        "stalled",
        { id: 3 },
        11,
      ),
    ).rejects.toThrow();
    await expect(takeoverAppend).rejects.toThrow("simulated cleanup interruption");
    await expect(
      openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
        "recovered",
        { id: 4 },
        13,
      ),
    ).resolves.toBeDefined();
    const retained = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["initial", "recovered"]);
  });

  it("persists keys and registration state without creating Reef files", async () => {
    const runtime = createRuntime(stateDir);
    const keys = await generateAndStoreKeys(runtime);
    expect(await loadKeys(createRuntime(stateDir))).toEqual(keys);
    const observation = observeHostDataSql({ OPENCLAW_STATE_DIR: stateDir });
    const sql = observation.calls;
    await bindIdentity(runtime, "molty");
    await saveReefSetupSession(runtime, {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });

    expect(await loadReefIdentityBinding(createRuntime(stateDir))).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    expect((await loadReefSetupSession(createRuntime(stateDir)))?.session).toBe("setup-secret");
    await clearReefSetupSession(runtime);
    expect(await loadReefSetupSession(runtime)).toBeUndefined();
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "data", "reef"))).toBe(false);
  });

  it.each(["worker", "legacy"] as const)(
    "atomically rejects redirecting stored identity keys to another handle (%s)",
    async (registrationHost) => {
      const runtime = createRuntime(stateDir, registrationHost);
      await bindIdentity(runtime, "molty");

      await expect(
        reserveReefIdentityBinding(runtime, {
          handle: "other",
          relayUrl: "https://reefwire.ai",
        }),
      ).rejects.toThrow("already holds the Reef identity @molty");
      expect(await loadReefIdentityBinding(runtime)).toEqual({
        handle: "molty",
        relayUrl: "https://reefwire.ai",
      });
      await expect(
        assertReefIdentityBinding(runtime, {
          handle: "other",
          relayUrl: "https://reefwire.ai",
        }),
      ).rejects.toThrow("already holds the Reef identity @molty");
    },
  );

  it.each(["worker", "legacy"] as const)(
    "conditionally releases or finalizes an identity reservation (%s)",
    async (registrationHost) => {
      const runtime = createRuntime(stateDir, registrationHost);
      const released = await reserveReefIdentityBinding(runtime, {
        handle: "first",
        relayUrl: "https://reefwire.ai",
      });
      await releaseReefIdentityReservation(runtime, released);
      expect(await loadReefIdentityBinding(runtime)).toBeUndefined();

      const finalized = await reserveReefIdentityBinding(runtime, {
        handle: "second",
        relayUrl: "https://reefwire.ai",
      });
      await finalizeReefIdentityBinding(runtime, finalized);
      await releaseReefIdentityReservation(runtime, finalized);
      expect(await loadReefIdentityBinding(runtime)).toEqual({
        handle: "second",
        relayUrl: "https://reefwire.ai",
      });
    },
  );

  it.each(["worker", "legacy"] as const)(
    "does not transfer a live reservation to a concurrent retry (%s)",
    async (registrationHost) => {
      const runtime = createRuntime(stateDir, registrationHost);
      const reservation = await reserveReefIdentityBinding(runtime, {
        handle: "molty",
        relayUrl: "https://reefwire.ai",
      });

      await expect(
        reserveReefIdentityBinding(runtime, {
          handle: "molty",
          relayUrl: "https://reefwire.ai",
        }),
      ).rejects.toThrow("already holds the Reef identity @molty");
      await finalizeReefIdentityBinding(runtime, reservation);
      expect((await loadReefIdentityBinding(runtime))?.handle).toBe("molty");
    },
  );

  it.each(["worker", "legacy"] as const)(
    "allows only the same binding to take over an expired reservation (%s)",
    async (registrationHost) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
      const runtime = createRuntime(stateDir, registrationHost);
      const original = await reserveReefIdentityBinding(runtime, {
        handle: "molty",
        relayUrl: "https://reefwire.ai",
      });
      vi.advanceTimersByTime(10 * 60_000 + 1);

      await expect(
        reserveReefIdentityBinding(runtime, {
          handle: "other",
          relayUrl: "https://reefwire.ai",
        }),
      ).rejects.toThrow("already holds the Reef identity @molty");
      const retry = await reserveReefIdentityBinding(runtime, {
        handle: "molty",
        relayUrl: "https://reefwire.ai",
      });
      await releaseReefIdentityReservation(runtime, original);
      await expect(finalizeReefIdentityBinding(runtime, original)).rejects.toThrow(
        "reservation was replaced",
      );
      await finalizeReefIdentityBinding(runtime, retry);
      expect((await loadReefIdentityBinding(runtime))?.handle).toBe("molty");
    },
  );

  it.each(["worker", "legacy"] as const)(
    "reserves only one identity when registrations overlap (%s)",
    async (registrationHost) => {
      const outcomes = await Promise.allSettled(
        ["first", "second"].map((handle) =>
          reserveReefIdentityBinding(createRuntime(stateDir, registrationHost), {
            handle,
            relayUrl: "https://reefwire.ai",
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
      if (winner?.status !== "fulfilled") {
        throw new Error("expected one registration to reserve the identity");
      }
      await finalizeReefIdentityBinding(createRuntime(stateDir, registrationHost), winner.value);
      expect(await loadReefIdentityBinding(createRuntime(stateDir, registrationHost))).toEqual(
        winner.value.binding,
      );
    },
  );

  it.each(["observe", "compareAndApply"] as const)(
    "does not switch to native callbacks when worker %s fails",
    async (method) => {
      const runtime = createRuntime(stateDir);
      const failure = new Error("registration worker unavailable");
      const open = runtime.state.openKeyedStore;
      runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => ({
        ...open<T>(options),
        [method]: async () => {
          throw failure;
        },
      });
      const openNative = vi.spyOn(runtime.state, "openSyncKeyedStore");
      await expect(
        reserveReefIdentityBinding(runtime, {
          handle: "molty",
          relayUrl: "https://reefwire.ai",
        }),
      ).rejects.toBe(failure);
      expect(openNative).not.toHaveBeenCalled();
    },
  );

  it("appends and reopens a verified audit chain", async () => {
    const keys = reefKeys();
    const first = openStores(createRuntime(stateDir), keys);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        first.audit.appendEvent("test", { id: index }, 10 + index),
      ),
    );

    const reopened = await openStores(createRuntime(stateDir), keys).audit.entries();
    expect(reopened).toHaveLength(20);
    expect(verifyChain(reopened)).toBe(true);
  });

  it("retains a verifiable audit suffix after bounded eviction", async () => {
    const keys = reefKeys();
    const store = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    await store.appendEvent("three", { id: 3 }, 12);

    const retained = await store.entries();
    expect(retained.map((entry) => entry.event.seq)).toEqual([2, 3]);
    expect(
      verifyChainSegment(retained, {
        previousHash: retained[0]!.prevHash,
        previousSeq: 1,
        head: retained[1]!.entryHash,
      }),
    ).toBe(true);
  });

  it("does not evict committed audit history when head advancement fails", async () => {
    const keys = reefKeys();
    const initial = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);

    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    let failAdvance = true;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      if (options.namespace !== "audit-head" || !store.update) {
        return store;
      }
      const update = store.update;
      return {
        ...store,
        update(key, updateValue, opts) {
          return update(
            key,
            (current) => {
              const next = updateValue(current);
              const head = next as { seq?: number; pending?: unknown } | undefined;
              if (failAdvance && head?.seq === 3 && head.pending === undefined) {
                failAdvance = false;
                throw new Error("simulated head write failure");
              }
              return next;
            },
            opts,
          );
        },
      };
    };

    const failing = openStores(runtime, keys, { auditMaxEntries: 2 }).audit;
    await expect(failing.appendEvent("three", { id: 3 }, 12)).rejects.toThrow();
    const unchanged = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(unchanged.map((entry) => entry.event.type)).toEqual(["one", "two"]);

    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "three",
      { id: 3 },
      12,
    );
    const recovered = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(recovered.map((entry) => entry.event.type)).toEqual(["two", "three"]);
  });

  it("roundtrips encrypted replay completions and durable dedupe state", async () => {
    const keys = reefKeys();
    const stores = openStores(createRuntime(stateDir), keys);
    const receipt = signReceipt(
      {
        id: receiptId,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      keys.signing.secretKey,
    );
    const body = { text: "RECOVERABLE SECRET BODY" };

    await expect(stores.replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    await stores.replay.complete("alice", receiptId, receipt, body);
    const reopened = openStores(createRuntime(stateDir), keys).replay;
    await expect(reopened.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("duplicate");
    await expect(reopened.completed("alice", receiptId)).resolves.toEqual({ receipt, body });
    await expect(reopened.claim("alice", receiptId, "d".repeat(64))).resolves.toBe("mismatch");

    const raw = createPluginStateSyncKeyedStoreForTests<unknown>("reef", {
      namespace: "replay",
      maxEntries: 3_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(JSON.stringify(raw.entries())).not.toContain(body.text);
  });

  it("does not steal a live replay claim owned by another process", async () => {
    const keys = reefKeys();
    const runtime = createRuntime(stateDir);
    const raw = createPluginStateSyncKeyedStoreForTests<{
      peer: string;
      id: string;
      envelopeHash: string;
      state: "in_flight";
      claimOwner: string;
      claimExpiresAt: number;
    }>("reef", {
      namespace: "replay",
      maxEntries: 3_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const key = reefReplayStoreKey("alice", receiptId);
    raw.register(key, {
      peer: "alice",
      id: receiptId,
      envelopeHash: "c".repeat(64),
      state: "in_flight",
      claimOwner: "other-process",
      claimExpiresAt: Date.now() + 5 * 60_000,
    });

    const replay = openStores(runtime, keys).replay;
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("in_flight");
    expect(raw.lookup(key)?.claimOwner).toBe("other-process");

    raw.register(key, {
      ...raw.lookup(key)!,
      claimExpiresAt: Date.now() - 1,
    });
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    const firstOwner = raw.lookup(key)?.claimOwner;
    expect(firstOwner).not.toBe("other-process");
    const firstExpiry = raw.lookup(key)?.claimExpiresAt ?? 0;
    await replay.refresh?.("alice", receiptId);
    expect(raw.lookup(key)?.claimExpiresAt).toBeGreaterThanOrEqual(firstExpiry);

    raw.register(key, {
      ...raw.lookup(key)!,
      claimExpiresAt: Date.now() - 1,
    });
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    expect(raw.lookup(key)?.claimOwner).not.toBe(firstOwner);
  });

  it("persists review decisions and delivered ids", async () => {
    const keys = reefKeys();
    const stores = openStores(createRuntime(stateDir), keys);
    const review = reviewRequest();

    await expect(stores.reviews.request(review)).resolves.toBeUndefined();
    await expect(stores.reviews.lookupDecision(review.approvalDigest)).resolves.toBe("pending");
    await expect(stores.reviews.lookupDecision("c".repeat(64))).resolves.toBe("none");
    const commandAuthority = createReefRuntimeAuthority();
    activateReviewStore(commandAuthority, createRuntime(stateDir), stores.reviews);
    try {
      for (const action of ["approve", "deny"]) {
        await expect(
          handleReefCommand({
            args: `review ${action} ${review.approvalDigest}`,
            senderIsOwner: true,
            assertOwnerCurrent: () => {
              throw new Error("owner revoked");
            },
          }),
        ).rejects.toThrow("owner revoked");
        await expect(stores.reviews.lookupDecision(review.approvalDigest)).resolves.toBe("pending");
      }
    } finally {
      commandAuthority.release();
    }
    await expect(stores.reviews.decide(review.approvalDigest, true)).resolves.toMatchObject({
      id: review.id,
      direction: "outbound",
    });
    await expect(stores.reviews.decide("c".repeat(64), true)).resolves.toBeUndefined();
    const pendingReview = { ...review, id: "pending", approvalDigest: "d".repeat(64) };
    await stores.reviews.request(pendingReview);
    const reopened = openStores(createRuntime(stateDir), keys);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const observation = observeHostDataSql({ OPENCLAW_STATE_DIR: stateDir });
    const sql = observation.calls;
    await expect(reopened.reviews.lookupDecision(review.approvalDigest)).resolves.toEqual({
      approved: true,
    });
    await expect(reopened.reviews.lookupDecision(pendingReview.approvalDigest)).resolves.toBe(
      "pending",
    );
    await expect(reopened.reviews.lookupDecision("c".repeat(64))).resolves.toBe("none");
    await expect(reopened.reviews.list()).resolves.toEqual([pendingReview]);
    const listReviews = registerReviewListCommand();
    const authority = createReefRuntimeAuthority();
    activateReviewStore(authority, createRuntime(stateDir), reopened.reviews);
    try {
      await expect(listReviews()).resolves.toEqual({
        text: `${pendingReview.approvalDigest} outbound alice#1 -> bob#1 ambiguous`,
      });
    } finally {
      authority.release();
    }
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
      operation.mockRestore();
    }
    await expect(reopened.reviews.request(review)).resolves.toEqual({
      approved: true,
      approvalDigest: review.approvalDigest,
    });
    await stores.delivered.add(receiptId);
    await expect(openStores(createRuntime(stateDir), keys).delivered.has(receiptId)).resolves.toBe(
      true,
    );
  });

  it.each(["lookup", "entries"] as const)(
    "rejects borrowed review %s results after channel revocation",
    async (method) => {
      const runtime = createRuntime(stateDir);
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const read = vi.fn(async () => {
        entered.resolve();
        await finish.promise;
        return method === "lookup" ? { approved: true } : [];
      });
      runtime.state.openKeyedStore = vi.fn().mockReturnValue({ [method]: read });
      const controller = new AbortController();
      const authority = createReefRuntimeAuthority(controller.signal);
      const reviews = new ReviewApprovalStore(runtime, undefined, authority.signal);
      activateReviewStore(authority, runtime, reviews);
      const listReviews = registerReviewListCommand();
      const pending = method === "lookup" ? reviews.lookupDecision("digest") : listReviews();
      const revoked = new Error("review account revoked");
      const rejected = expect(pending).rejects.toBe(revoked);
      try {
        await entered.promise;
        controller.abort(revoked);
        finish.resolve();
        await rejected;
        await expect(
          method === "lookup" ? reviews.lookupDecision("digest") : reviews.list(),
        ).rejects.toBe(revoked);
        expect(read).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        authority.release();
        await pending.catch(() => {});
      }
    },
  );

  it.each(["lookup", "entries"] as const)(
    "uses the required async %s contract without optional capabilities or native fallback",
    async (method) => {
      const runtime = createRuntime(stateDir);
      const native = runtime.state.openSyncKeyedStore({
        namespace: REEF_REVIEWS_NAMESPACE,
        maxEntries: 2_000,
        overflowPolicy: "reject-new",
      });
      const nativeLookup = vi.spyOn(native, "lookup");
      const nativeEntries = vi.spyOn(native, "entries");
      runtime.state.openSyncKeyedStore = vi.fn().mockReturnValue(native);
      const value = method === "lookup" ? { approved: false } : [];
      const read = vi.fn().mockResolvedValue(value);
      runtime.state.openKeyedStore = vi.fn().mockReturnValue({ [method]: read });
      const reviews = new ReviewApprovalStore(runtime);
      const run = () => (method === "lookup" ? reviews.lookupDecision("digest") : reviews.list());
      await expect(run()).resolves.toEqual(method === "lookup" ? { approved: false } : []);
      const failed = new Error("review read failed");
      read.mockRejectedValueOnce(failed);
      await expect(run()).rejects.toBe(failed);
      expect(nativeLookup).not.toHaveBeenCalled();
      expect(nativeEntries).not.toHaveBeenCalled();
    },
  );

  it("fails closed instead of evicting live replay and delivered state", async () => {
    const keys = reefKeys();
    const stores = openStores(createRuntime(stateDir), keys, {
      replayMaxEntries: 1,
      deliveredMaxEntries: 1,
    });

    await expect(stores.replay.claim("alice", "first", "a".repeat(64))).resolves.toBe("new");
    await stores.replay.consume("alice", "first");
    await expect(stores.replay.claim("alice", "second", "b".repeat(64))).rejects.toThrow();
    await expect(stores.replay.claim("alice", "first", "a".repeat(64))).resolves.toBe("duplicate");

    await stores.delivered.add("first");
    await expect(stores.delivered.add("second")).rejects.toThrow();
    await expect(stores.delivered.has("first")).resolves.toBe(true);
  });

  it("fails when a pending review claim does not persist", async () => {
    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      return options.namespace === REEF_REVIEWS_NAMESPACE
        ? { ...store, registerIfAbsent: () => false }
        : store;
    };
    const review = reviewRequest();

    await expect(new ReviewApprovalStore(runtime).request(review)).rejects.toThrow(
      "Failed persisting Reef pending review",
    );
  });

  it("fails when a delivered marker claim does not persist", async () => {
    const keys = reefKeys();
    const runtime = createRuntime(stateDir);
    const openKeyedStore = runtime.state.openKeyedStore;
    runtime.state.openKeyedStore = <T>(
      options: OpenAsyncKeyedStoreOptions,
    ): PluginStateKeyedStore<T> => {
      const store = openKeyedStore<T>(options);
      return options.namespace === REEF_DELIVERED_NAMESPACE
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    };

    await expect(openStores(runtime, keys).delivered.add(receiptId)).rejects.toThrow(
      "Failed persisting Reef delivered marker",
    );
  });

  it("evicts completed review decisions before rejecting new pending work", async () => {
    const runtime = createRuntime(stateDir);
    const store = new ReviewApprovalStore(runtime, 2);

    const first = reviewRequest("first", "1".repeat(64));
    const second = reviewRequest("second", "2".repeat(64));
    const third = reviewRequest("third", "3".repeat(64));

    await store.request(first);
    await store.decide(first.approvalDigest, false);
    await store.request(second);
    await store.request(third);

    await expect(store.list()).resolves.toEqual([second, third]);
  });
});

describe("Reef delivered markers", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function testKeys() {
    const identity = generateIdentity();
    return { ...identity, auditKey, replayKey, keyEpoch: 1 };
  }

  it("confirms delivered markers idempotently", async () => {
    const observation = observeHostDataSql({ OPENCLAW_STATE_DIR: stateDir });
    const sql = observation.calls;
    const delivered = new ReefDeliveredStore(createRuntime(stateDir));
    await expect(delivered.status("m1")).resolves.toBeUndefined();
    await expect(delivered.has("m1")).resolves.toBe(false);
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await expect(delivered.has("m1")).resolves.toBe(true);
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.add("m2");
    await expect(delivered.status("m2")).resolves.toBe("delivered");
    await expect(new ReefDeliveredStore(createRuntime(stateDir)).has("m2")).resolves.toBe(true);
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("surfaces capacity as PLUGIN_STATE_LIMIT_EXCEEDED from confirm without touching existing markers", async () => {
    const stores = openStores(createRuntime(stateDir), testKeys(), {
      deliveredMaxEntries: 1,
    });
    await stores.delivered.add("first"); // delivered namespace full
    // Confirming into a full delivered namespace fails closed. No marker is
    // retained, so the re-poll re-ingresses before retrying confirmation.
    await expect(stores.delivered.confirm("second")).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expect(stores.delivered.status("second")).resolves.toBeUndefined();
    await expect(stores.delivered.status("first")).resolves.toBe("delivered");
    await expect(stores.delivered.status("third")).resolves.toBeUndefined();
  });

  it("reads legacy delivered markers without a state as delivered", async () => {
    const runtime = createRuntime(stateDir);
    const stores = openStores(runtime, testKeys());
    const legacy = runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: REEF_DELIVERED_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    legacy.registerIfAbsent("legacy-1", { id: "legacy-1" });
    await expect(stores.delivered.status("legacy-1")).resolves.toBe("delivered");
    await expect(stores.delivered.has("legacy-1")).resolves.toBe(true);
  });
});
