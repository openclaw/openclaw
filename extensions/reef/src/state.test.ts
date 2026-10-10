import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateOperationReceipt,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { base64url, generateIdentity, signReceipt, type ReviewRequest } from "../protocol/index.js";
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
import {
  beforeNextStateOperation,
  cleanupStateTestDirectory,
  expectReefStateOperationError,
  createRuntime,
  createStateTestDirectory,
} from "./state.test-support.js";
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
    stateDir = createStateTestDirectory();
  });

  afterEach(async () => {
    await cleanupStateTestDirectory(stateDir);
  });

  it("persists a monotonic inbox cursor for the bound Reef identity", async () => {
    const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
    const requested = { ...binding };
    const store = new ReefInboxCursorStore(createRuntime(stateDir), requested);
    requested.handle = "changed";

    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);

    expect(await new ReefInboxCursorStore(createRuntime(stateDir), binding).load()).toBe(12);
    await expectReefStateOperationError(
      new ReefInboxCursorStore(createRuntime(stateDir), {
        handle: "clawd",
        relayUrl: "https://reefwire.ai",
      }).load(),
      "Reef inbox cursor belongs to a different identity",
    );
  });

  it("keeps the last inbox cursor when channel authority expires before commit", async () => {
    const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
    const controller = new AbortController();
    const runtime = createRuntime(stateDir);
    const store = new ReefInboxCursorStore(runtime, binding, controller.signal);
    await store.advance(12);
    const revoked = new Error("inbox authority expired");
    beforeNextStateOperation(runtime, () => controller.abort(revoked));

    await expect(store.advance(13)).rejects.toBe(revoked);
    await expect(new ReefInboxCursorStore(createRuntime(stateDir), binding).load()).resolves.toBe(
      12,
    );
  });

  it.each([
    [
      "durable-migration",
      "legacy-files",
      { pending: true },
      "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix",
    ],
    [
      "identity-migration",
      "keys-json",
      { pending: true },
      "Reef identity migration is incomplete; repair the legacy identity files and rerun openclaw doctor --fix",
    ],
    [
      "registration",
      "identity",
      { handle: "original", relayUrl: "https://reefwire.ai" },
      "Reef identity @original on https://reefwire.ai has no canonical keys; restore the original keys before registration",
    ],
  ] as const)(
    "rechecks a concurrent %s guard before creating keys",
    async (namespace, key, value, error) => {
      const runtime = createRuntime(stateDir);
      const guard = runtime.state.openKeyedStore({
        namespace,
        maxEntries: namespace === "registration" ? 2 : 1,
        overflowPolicy: "reject-new",
      });
      beforeNextStateOperation(runtime, () => guard.register(key, value));

      await expectReefStateOperationError(generateAndStoreKeys(runtime), error);
      await expect(
        runtime.state
          .openKeyedStore({
            namespace: "identity",
            maxEntries: 1,
            overflowPolicy: "reject-new",
          })
          .lookup("keys"),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["worker", "legacy"] as const)(
    "does not create a database for missing identity reads or store admission (%s)",
    async (host) => {
      const runtime = createRuntime(stateDir, host);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

      await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fs.existsSync(databasePath)).toBe(false);
      await openStores(runtime, reefKeys());
      expect(fs.existsSync(databasePath)).toBe(false);
    },
  );

  it("persists keys and registration state without creating Reef files", async () => {
    const runtime = createRuntime(stateDir);
    const observation = observeHostDataSql();
    const sql = observation.calls;
    const keys = await generateAndStoreKeys(runtime);
    expect(await loadKeys(createRuntime(stateDir))).toEqual(keys);
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

  it("retains native key and review semantics on released hosts without operations", async () => {
    const runtime = createRuntime(stateDir, "legacy");
    const creation = generateAndStoreKeys(runtime);
    const rawKeys = runtime.state.openSyncKeyedStore({
      namespace: "identity",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    expect(rawKeys.lookup("keys")).toBeDefined();
    const keys = await creation;
    await expect(loadKeys(runtime)).resolves.toEqual(keys);
    await expect(loadKeys(createRuntime(stateDir))).resolves.toEqual(keys);

    const reviews = new ReviewApprovalStore(runtime, 1);
    const first = reviewRequest("first", "1".repeat(64));
    const second = reviewRequest("second", "2".repeat(64));
    await reviews.request(first);
    const revoked = new Error("owner revoked");
    await expect(
      reviews.decide(first.approvalDigest, true, () => {
        throw revoked;
      }),
    ).rejects.toBe(revoked);
    await expect(reviews.lookupDecision(first.approvalDigest)).resolves.toBe("pending");
    await reviews.decide(first.approvalDigest, false);
    await reviews.request(second);
    await expect(new ReviewApprovalStore(createRuntime(stateDir), 1).list()).resolves.toEqual([
      second,
    ]);

    runtime.state
      .openSyncKeyedStore({
        namespace: "durable-migration",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      })
      .register("legacy-files", { pending: true });
    await expect(loadKeys(runtime)).rejects.toThrow("durable state migration is incomplete");
    await expect(openStores(runtime, keys)).rejects.toThrow(
      "durable state migration is incomplete",
    );
  });

  it.each(["keys", "review", "cursor"] as const)(
    "never switches %s to native storage after a current-host operation failure",
    async (operation) => {
      const runtime = createRuntime(stateDir);
      const failure = new Error("operation worker unavailable");
      beforeNextStateOperation(runtime, () => {
        throw failure;
      });
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      const pending =
        operation === "keys"
          ? generateAndStoreKeys(runtime)
          : operation === "review"
            ? new ReviewApprovalStore(runtime).request(reviewRequest())
            : new ReefInboxCursorStore(runtime, {
                handle: "molty",
                relayUrl: "https://reefwire.ai",
              }).advance(1);

      await expect(pending).rejects.toBe(failure);
      expect(native).not.toHaveBeenCalled();
    },
  );

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

  it("roundtrips encrypted replay completions and durable dedupe state", async () => {
    const keys = reefKeys();
    const stores = await openStores(createRuntime(stateDir), keys);
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
    const reopened = (await openStores(createRuntime(stateDir), keys)).replay;
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

    const replay = (await openStores(runtime, keys)).replay;
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
    const stores = await openStores(createRuntime(stateDir), keys);
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
    const reopened = await openStores(createRuntime(stateDir), keys);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const observation = observeHostDataSql();
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
    await stores.delivered.confirm(receiptId);
    await expect(
      (await openStores(createRuntime(stateDir), keys)).delivered.status(receiptId),
    ).resolves.toBe("delivered");
  });

  it.each(["keys", "lookup", "list"] as const)(
    "rejects a borrowed worker %s result after authority revocation",
    async (method) => {
      const runtime = createRuntime(stateDir);
      const controller = new AbortController();
      const reviews = new ReviewApprovalStore(runtime, undefined, controller.signal);
      if (method === "keys") {
        await generateAndStoreKeys(runtime);
      } else {
        await reviews.request(reviewRequest());
      }
      const refusal = new Error("borrowed worker state expired");
      beforeNextStateOperation(runtime, () => controller.abort(refusal), "after");

      await expect(
        method === "keys"
          ? loadKeys(runtime, () => controller.signal.throwIfAborted())
          : method === "lookup"
            ? reviews.lookupDecision(reviewRequest().approvalDigest)
            : reviews.list(),
      ).rejects.toBe(refusal);
    },
  );

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
    const stores = await openStores(createRuntime(stateDir), keys, {
      replayMaxEntries: 1,
      deliveredMaxEntries: 1,
    });

    await expect(stores.replay.claim("alice", receiptId, "a".repeat(64))).resolves.toBe("new");
    await stores.replay.complete(
      "alice",
      receiptId,
      signReceipt(
        {
          id: receiptId,
          bodyHash: "a".repeat(64),
          auditHead: "c".repeat(64),
          status: "accepted",
        },
        keys.signing.secretKey,
      ),
      { text: "first" },
    );
    await expect(stores.replay.claim("alice", "second", "b".repeat(64))).rejects.toThrow();
    await expect(stores.replay.claim("alice", receiptId, "a".repeat(64))).resolves.toBe(
      "duplicate",
    );

    await stores.delivered.confirm("first");
    await expect(stores.delivered.confirm("second")).rejects.toThrow();
    await expect(stores.delivered.status("first")).resolves.toBe("delivered");
  });

  it("never treats a malformed stored approval as owner authorization", async () => {
    const runtime = createRuntime(stateDir);
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const raw = runtime.state.openKeyedStore({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries: 2_000,
      overflowPolicy: "reject-new",
    });
    const malformed = { review, approved: "false" };
    await raw.register(review.approvalDigest, malformed);
    for (const operation of [
      () => reviews.lookupDecision(review.approvalDigest),
      () => reviews.request(review),
      () => reviews.decide(review.approvalDigest, true),
    ]) {
      await expectReefStateOperationError(operation(), "invalid Reef review record");
    }
    await expect(raw.lookup(review.approvalDigest)).resolves.toEqual(malformed);
  });

  it("preserves a review replaced by pending work before transaction admission", async () => {
    const runtime = createRuntime(stateDir);
    const reviews = new ReviewApprovalStore(runtime, 1);
    const first = reviewRequest("first", "1".repeat(64));
    const next = reviewRequest("next", "2".repeat(64));
    await reviews.request(first);
    await reviews.decide(first.approvalDigest, true);
    const raw = runtime.state.openKeyedStore({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    beforeNextStateOperation(runtime, () => raw.register(first.approvalDigest, { review: first }));

    await expectReefStateOperationError(
      reviews.request(next),
      "Reef pending review capacity is exhausted",
      "ReefReviewCapacityError",
    );
    await expect(reviews.list()).resolves.toEqual([first]);
    await expect(reviews.lookupDecision(next.approvalDigest)).resolves.toBe("none");
  });

  it.each(["request", "channel decision", "owner decision"] as const)(
    "refuses %s after authority expires before worker admission",
    async (action) => {
      const runtime = createRuntime(stateDir);
      const controller = new AbortController();
      const reviews = new ReviewApprovalStore(runtime, 1, controller.signal);
      const first = reviewRequest("first", "1".repeat(64));
      await reviews.request(first);
      if (action === "request") {
        await reviews.decide(first.approvalDigest, false);
      }
      const revoked = new Error("review authority expired");
      let ownerCurrent = true;
      const assertOwnerCurrent = () => {
        if (!ownerCurrent) {
          throw revoked;
        }
      };
      beforeNextStateOperation(runtime, () => {
        if (action === "owner decision") {
          ownerCurrent = false;
        } else {
          controller.abort(revoked);
        }
      });
      await expect(
        action === "request"
          ? reviews.request(reviewRequest("next", "2".repeat(64)))
          : reviews.decide(first.approvalDigest, true, assertOwnerCurrent),
      ).rejects.toBe(revoked);
      const reopened = new ReviewApprovalStore(createRuntime(stateDir), 1);
      await expect(reopened.lookupDecision(first.approvalDigest)).resolves.toEqual(
        action === "request" ? { approved: false } : "pending",
      );
      await expect(reopened.lookupDecision("2".repeat(64))).resolves.toBe("none");
    },
  );

  it("invalidates approval receipts immediately and orders review mutations across handles", async () => {
    const runtime = createRuntime(stateDir);
    const reviews = new ReviewApprovalStore(runtime);
    const sibling = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    await reviews.request(review);
    await reviews.decide(review.approvalDigest, true);
    const receipts: PluginStateOperationReceipt<unknown>[] = [];
    beforeNextStateOperation(
      runtime,
      (receipt) => {
        if (!receipt) {
          throw new Error("Expected a completed review operation receipt");
        }
        receipts.push(receipt);
      },
      "after",
    );
    await expect(reviews.lookupDecision(review.approvalDigest)).resolves.toEqual({
      approved: true,
    });
    const receipt = receipts[0]!;
    receipt.assertCurrent();

    const revocation = reviews.decide(review.approvalDigest, false);
    const pending: Promise<unknown>[] = [revocation];
    try {
      expect(() => receipt.assertCurrent()).toThrow("no longer current");
      const reapproval = reviews.decide(review.approvalDigest, true);
      const finalRevocation = sibling.decide(review.approvalDigest, false);
      const observed = reviews.lookupDecision(review.approvalDigest);
      pending.push(reapproval, finalRevocation, observed);
      await expect(revocation).resolves.toEqual(review);
      await expect(reapproval).resolves.toEqual(review);
      await expect(finalRevocation).resolves.toEqual(review);
      await expect(observed).resolves.toEqual({ approved: false });
    } finally {
      await Promise.allSettled(pending);
    }
  });

  it("captures review identity and source while an earlier acknowledgement waits", async () => {
    const runtime = createRuntime(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("reef", { ...options, env });
      runtime.stateStores.push(store);
      return store;
    };
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const original = structuredClone(review);
    const retained = reviewRequest("retained", "d".repeat(64));
    await reviews.request(retained);

    const redirectedDir = path.join(stateDir, "redirected");
    const redirected = new ReviewApprovalStore(createRuntime(redirectedDir));
    await redirected.request({ ...original, id: "redirected" });
    await redirected.decide(original.approvalDigest, false);
    await redirected.request(reviewRequest("elsewhere", "e".repeat(64)));

    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    beforeNextStateOperation(
      runtime,
      async () => {
        entered.resolve();
        await finish.promise;
      },
      "after",
    );
    const request = reviews.request(review);
    review.id = "changed";
    review.approvalDigest = "c".repeat(64);
    await entered.promise;
    const decision = reviews.decide(original.approvalDigest, true);
    const lookup = reviews.lookupDecision(original.approvalDigest);
    const pending = reviews.list();
    env.OPENCLAW_STATE_DIR = redirectedDir;
    finish.resolve();

    try {
      await expect(request).resolves.toBeUndefined();
      await expect(decision).resolves.toEqual(original);
      await expect(lookup).resolves.toEqual({ approved: true });
      await expect(pending).resolves.toEqual([retained]);
      const reopened = new ReviewApprovalStore(createRuntime(stateDir));
      await expect(reopened.lookupDecision(review.approvalDigest)).resolves.toBe("none");
    } finally {
      finish.resolve();
      await Promise.allSettled([request, decision, lookup, pending]);
    }
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

    await expect((await openStores(runtime, keys)).delivered.confirm(receiptId)).rejects.toThrow(
      "Failed persisting Reef delivered marker",
    );
  });

  it("evicts completed review decisions before rejecting new pending work", async () => {
    const sql = observeHostDataSql();
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
    for (const operation of sql.calls) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});

describe("Reef delivered markers", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = createStateTestDirectory();
  });

  afterEach(async () => {
    await cleanupStateTestDirectory(stateDir);
  });

  function testKeys() {
    const identity = generateIdentity();
    return { ...identity, auditKey, replayKey, keyEpoch: 1 };
  }

  it("confirms delivered markers idempotently", async () => {
    const observation = observeHostDataSql();
    const sql = observation.calls;
    const delivered = new ReefDeliveredStore(createRuntime(stateDir));
    await expect(delivered.status("m1")).resolves.toBeUndefined();
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.confirm("m2");
    await expect(delivered.status("m2")).resolves.toBe("delivered");
    await expect(new ReefDeliveredStore(createRuntime(stateDir)).status("m2")).resolves.toBe(
      "delivered",
    );
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("surfaces capacity as PLUGIN_STATE_LIMIT_EXCEEDED from confirm without touching existing markers", async () => {
    const stores = await openStores(createRuntime(stateDir), testKeys(), {
      deliveredMaxEntries: 1,
    });
    await stores.delivered.confirm("first"); // delivered namespace full
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
    const stores = await openStores(runtime, testKeys());
    const legacy = runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: REEF_DELIVERED_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    legacy.registerIfAbsent("legacy-1", { id: "legacy-1" });
    await expect(stores.delivered.status("legacy-1")).resolves.toBe("delivered");
  });
});
