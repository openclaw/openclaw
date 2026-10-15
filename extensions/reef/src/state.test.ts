import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateOperationReceipt,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
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
import { base64url, generateIdentity, type ReviewRequest } from "../protocol/index.js";
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
  REEF_DELIVERED_NAMESPACE,
  ReefDeliveredStore,
  ReefInboxCursorStore,
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
      "Reef identity @original on https://reefwire.ai has no stored keys; restore the original keys before registration",
    ],
  ] as const)(
    "rechecks a concurrent %s guard before creating keys",
    async (namespace, key, value, error) => {
      const runtime = createRuntime(stateDir);
      const guard = runtime.state.openKeyedStoreV2({
        namespace,
        maxEntries: namespace === "registration" ? 2 : 1,
        overflowPolicy: "reject-new",
      });
      beforeNextStateOperation(runtime, () => guard.register(key, value));

      await expectReefStateOperationError(generateAndStoreKeys(runtime), error);
      await expect(
        runtime.state
          .openKeyedStoreV2({
            namespace: "identity",
            maxEntries: 1,
            overflowPolicy: "reject-new",
          })
          .lookup("keys"),
      ).resolves.toBeUndefined();
    },
  );

  it("does not create a database for missing identity reads or store admission", async () => {
    const runtime = createRuntime(stateDir);
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

    await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.existsSync(databasePath)).toBe(false);
    await openStores(runtime, reefKeys());
    expect(fs.existsSync(databasePath)).toBe(false);
  });

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

  it("atomically rejects redirecting stored identity keys to another handle", async () => {
    const runtime = createRuntime(stateDir);
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
  });

  it("conditionally releases or finalizes an identity reservation", async () => {
    const runtime = createRuntime(stateDir);
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
  });

  it("does not transfer a live reservation to a concurrent retry", async () => {
    const runtime = createRuntime(stateDir);
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
  });

  it("allows only the same binding to take over an expired reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const runtime = createRuntime(stateDir);
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
  });

  it("reserves only one identity when registrations overlap", async () => {
    const outcomes = await Promise.allSettled(
      ["first", "second"].map((handle) =>
        reserveReefIdentityBinding(createRuntime(stateDir), {
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
    await finalizeReefIdentityBinding(createRuntime(stateDir), winner.value);
    expect(await loadReefIdentityBinding(createRuntime(stateDir))).toEqual(winner.value.binding);
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

  it("never treats a malformed stored approval as owner authorization", async () => {
    const runtime = createRuntime(stateDir);
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const raw = runtime.state.openKeyedStoreV2({
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
    const raw = runtime.state.openKeyedStoreV2({
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
    runtime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreV2ForTests<T>(
        "reef",
        { ...options, env },
        { assertCurrent() {} },
      );
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
    const openKeyedStore = runtime.state.openKeyedStoreV2;
    runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
    ): PluginStateKeyedStore<T, 2> => {
      const store = openKeyedStore<T>(options);
      return options.namespace === REEF_DELIVERED_NAMESPACE
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    };

    await expect((await openStores(runtime, keys)).delivered.confirm(receiptId)).rejects.toThrow(
      "Failed persisting Reef delivered marker",
    );
  });

  it("deduplicates concurrent pending reviews and evicts only completed decisions at capacity", async () => {
    const sql = observeHostDataSql();
    const runtime = createRuntime(stateDir);
    const store = new ReviewApprovalStore(runtime, 1);

    const first = reviewRequest("first", "1".repeat(64));
    const second = reviewRequest("second", "2".repeat(64));
    const third = reviewRequest("third", "3".repeat(64));

    await expect(Promise.all([store.request(first), store.request(first)])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await store.decide(first.approvalDigest, false);
    await store.request(second);
    await expectReefStateOperationError(
      store.request(third),
      "Reef pending review capacity is exhausted",
      "ReefReviewCapacityError",
    );

    await expect(store.list()).resolves.toEqual([second]);
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
});
