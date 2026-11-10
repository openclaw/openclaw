import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRequest } from "../protocol/index.js";
import { MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { openReefAuditStore } from "./audit-state.js";
import { handleReefCommand } from "./commands.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefMessageFlow } from "./flow.js";
import { allow, reefKeys } from "./flow.test-helpers.js";
import { ReefFriendManager } from "./friends.js";
import { REEF_REPLAY_TTL_MS, reefReplayStoreKey, type ReefReplayRecord } from "./replay-store.js";
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

const receiptId = "01JZ0000000000000000000000";
const identityBinding = (handle: string) => ({ handle, relayUrl: "https://reefwire.ai" });
let stateDir = "";
let runtime: ReturnType<typeof createRuntime>;
const reopen = () => createRuntime(stateDir);
const reserve = (handle: string) => reserveReefIdentityBinding(runtime, identityBinding(handle));

beforeEach(() => {
  stateDir = createStateTestDirectory();
  runtime = reopen();
});
afterEach(() => cleanupStateTestDirectory(stateDir));

const rawStore = (namespace: string, maxEntries = 1) =>
  runtime.state.openKeyedStoreV2({ namespace, maxEntries, overflowPolicy: "reject-new" });

function assertNoHostSql(calls: ReturnType<typeof observeHostDataSql>["calls"], restore = false) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
    if (restore) {
      call.mockRestore();
    }
  }
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
      ...allow,
      decision: "review",
      category: "ambiguous",
      reason: "Owner review.",
    },
  };
}

function activateReviewStore(reviews: ReviewApprovalStore) {
  const authority = createReefRuntimeAuthority();
  const stateRuntime = reopen();
  const config = ReefChannelConfigSchema.parse({ handle: "bob" });
  const keys = reefKeys();
  const transport = new ReefTransportClient(config.relayUrl, "bob", keys, async () => {
    throw new Error("Unexpected relay request during review listing");
  });
  const trust = openReefTrustStore(stateRuntime, config);
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
      delivered: new ReefDeliveredStore(stateRuntime),
      audit: openReefAuditStore(stateRuntime, new Uint8Array(32).fill(1)),
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
  return () => authority.release();
}

async function bindIdentity(handle: string): Promise<void> {
  await finalizeReefIdentityBinding(runtime, await reserve(handle));
}

describe("Reef SQLite state", () => {
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
      identityBinding("original"),
      "Reef identity @original on https://reefwire.ai has no stored keys; restore the original keys before registration",
    ],
  ] as const)(
    "rechecks a concurrent %s guard before creating keys",
    async (namespace, key, value, error) => {
      const guard = rawStore(namespace, namespace === "registration" ? 2 : 1);
      beforeNextStateOperation(runtime, () => guard.register(key, value));

      await expectReefStateOperationError(generateAndStoreKeys(runtime), error);
      expect(await rawStore("identity").lookup("keys")).toBeUndefined();
    },
  );

  it("does not create a database for missing identity reads or store admission", async () => {
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

    await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.existsSync(databasePath)).toBe(false);
    await openStores(runtime, reefKeys());
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("persists keys and registration state without creating Reef files", async () => {
    const sql = observeHostDataSql().calls;
    const keys = await generateAndStoreKeys(runtime);
    expect(await loadKeys(reopen())).toEqual(keys);
    await bindIdentity("molty");
    await saveReefSetupSession(runtime, {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });

    expect(await loadReefIdentityBinding(reopen())).toEqual(identityBinding("molty"));
    expect((await loadReefSetupSession(reopen()))?.session).toBe("setup-secret");
    await clearReefSetupSession(runtime);
    expect(await loadReefSetupSession(runtime)).toBeUndefined();
    assertNoHostSql(sql);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "data", "reef"))).toBe(false);
  });

  it("atomically rejects redirecting stored identity keys to another handle", async () => {
    await bindIdentity("molty");

    await expect(reserve("other")).rejects.toThrow("already holds the Reef identity @molty");
    expect(await loadReefIdentityBinding(runtime)).toEqual(identityBinding("molty"));
    await expect(assertReefIdentityBinding(runtime, identityBinding("other"))).rejects.toThrow(
      "already holds the Reef identity @molty",
    );
  });

  it("conditionally releases or finalizes an identity reservation", async () => {
    const released = await reserve("first");
    await releaseReefIdentityReservation(runtime, released);
    expect(await loadReefIdentityBinding(runtime)).toBeUndefined();

    const finalized = await reserve("second");
    await finalizeReefIdentityBinding(runtime, finalized);
    await releaseReefIdentityReservation(runtime, finalized);
    expect(await loadReefIdentityBinding(runtime)).toEqual(identityBinding("second"));
  });

  it("does not transfer a live reservation to a concurrent retry", async () => {
    const reservation = await reserve("molty");

    await expect(reserve("molty")).rejects.toThrow("already holds the Reef identity @molty");
    await finalizeReefIdentityBinding(runtime, reservation);
    expect((await loadReefIdentityBinding(runtime))?.handle).toBe("molty");
  });

  it("allows only the same binding to take over an expired reservation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const original = await reserve("molty");
    vi.advanceTimersByTime(10 * 60_000 + 1);

    await expect(reserve("other")).rejects.toThrow("already holds the Reef identity @molty");
    const retry = await reserve("molty");
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
        reserveReefIdentityBinding(reopen(), identityBinding(handle)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") {
      throw new Error("expected one registration to reserve the identity");
    }
    await finalizeReefIdentityBinding(reopen(), winner.value);
    expect(await loadReefIdentityBinding(reopen())).toEqual(winner.value.binding);
  });

  it("does not steal a live replay claim owned by another process", async () => {
    const raw = createPluginStateSyncKeyedStoreForTests<ReefReplayRecord>("reef", {
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

    const replay = (await openStores(runtime, reefKeys())).replay;
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

  it("persists review decisions", async () => {
    const keys = reefKeys();
    const { reviews } = await openStores(reopen(), keys);
    const review = reviewRequest();
    const digest = review.approvalDigest;

    await expect(reviews.request(review)).resolves.toBeUndefined();
    await expect(reviews.observeDecision(digest).then((receipt) => receipt.value)).resolves.toBe(
      "pending",
    );
    await expect(
      reviews.observeDecision("c".repeat(64)).then((receipt) => receipt.value),
    ).resolves.toBe("none");
    const releaseCommand = activateReviewStore(reviews);
    try {
      for (const action of ["approve", "deny"]) {
        await expect(
          handleReefCommand({
            args: `review ${action} ${digest}`,
            senderIsOwner: true,
            assertOwnerCurrent: () => {
              throw new Error("owner revoked");
            },
          }),
        ).rejects.toThrow("owner revoked");
        await expect(
          reviews.observeDecision(digest).then((receipt) => receipt.value),
        ).resolves.toBe("pending");
      }
    } finally {
      releaseCommand();
    }
    await expect(reviews.decide(digest, true)).resolves.toMatchObject({
      id: review.id,
      direction: "outbound",
    });
    await expect(reviews.decide("c".repeat(64), true)).resolves.toBeUndefined();
    const pendingReview = { ...review, id: "pending", approvalDigest: "d".repeat(64) };
    await reviews.request(pendingReview);
    const { reviews: restored } = await openStores(reopen(), keys);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const sql = observeHostDataSql().calls;
    await expect(
      restored.observeDecision(digest).then((receipt) => receipt.value),
    ).resolves.toEqual({
      approved: true,
    });
    await expect(
      restored.observeDecision(pendingReview.approvalDigest).then((receipt) => receipt.value),
    ).resolves.toBe("pending");
    await expect(
      restored.observeDecision("c".repeat(64)).then((receipt) => receipt.value),
    ).resolves.toBe("none");
    await expect(restored.list()).resolves.toEqual([pendingReview]);
    const releaseList = activateReviewStore(restored);
    try {
      await expect(handleReefCommand({ args: "review list" })).resolves.toEqual({
        text: `${pendingReview.approvalDigest} outbound alice#1 -> bob#1 ambiguous`,
      });
    } finally {
      releaseList();
    }
    assertNoHostSql(sql, true);
    await expect(restored.request(review)).resolves.toEqual({
      approved: true,
      approvalDigest: digest,
    });
  });

  it.each(["keys", "lookup", "list"] as const)(
    "rejects a borrowed worker %s result after authority revocation",
    async (method) => {
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
            ? reviews.observeDecision(reviewRequest().approvalDigest)
            : reviews.list(),
      ).rejects.toBe(refusal);
    },
  );

  it("never treats a malformed stored approval as owner authorization", async () => {
    const reviews = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    const raw = rawStore(REEF_REVIEWS_NAMESPACE, 2_000);
    const malformed = { review, approved: "false" };
    await raw.register(review.approvalDigest, malformed);
    for (const operation of [
      () => reviews.observeDecision(review.approvalDigest),
      () => reviews.request(review),
      () => reviews.decide(review.approvalDigest, true),
    ]) {
      await expectReefStateOperationError(operation(), "invalid Reef review record");
    }
    await expect(raw.lookup(review.approvalDigest)).resolves.toEqual(malformed);
  });

  it("preserves a review replaced by pending work before transaction admission", async () => {
    const reviews = new ReviewApprovalStore(runtime, 1);
    const first = reviewRequest("first", "1".repeat(64));
    const next = reviewRequest("next", "2".repeat(64));
    await reviews.request(first);
    await reviews.decide(first.approvalDigest, true);
    const raw = rawStore(REEF_REVIEWS_NAMESPACE);
    beforeNextStateOperation(runtime, () => raw.register(first.approvalDigest, { review: first }));

    await expectReefStateOperationError(
      reviews.request(next),
      "Reef pending review capacity is exhausted",
      "ReefReviewCapacityError",
    );
    await expect(reviews.list()).resolves.toEqual([first]);
    await expect(
      reviews.observeDecision(next.approvalDigest).then((receipt) => receipt.value),
    ).resolves.toBe("none");
  });

  it.each(["request", "channel decision", "owner decision"] as const)(
    "refuses %s after authority expires before worker admission",
    async (action) => {
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
      const reopened = new ReviewApprovalStore(reopen(), 1);
      await expect(
        reopened.observeDecision(first.approvalDigest).then((receipt) => receipt.value),
      ).resolves.toEqual(action === "request" ? { approved: false } : "pending");
      await expect(
        reopened.observeDecision("2".repeat(64)).then((receipt) => receipt.value),
      ).resolves.toBe("none");
    },
  );

  it("invalidates approval receipts immediately and orders review mutations across handles", async () => {
    const reviews = new ReviewApprovalStore(runtime);
    const sibling = new ReviewApprovalStore(runtime);
    const review = reviewRequest();
    await reviews.request(review);
    await reviews.decide(review.approvalDigest, true);
    const receipt = await reviews.observeDecision(review.approvalDigest);
    expect(receipt.value).toEqual({ approved: true });
    receipt.assertCurrent();

    const revocation = reviews.decide(review.approvalDigest, false);
    const pending: Promise<unknown>[] = [revocation];
    try {
      expect(() => receipt.assertCurrent()).toThrow("no longer current");
      const reapproval = reviews.decide(review.approvalDigest, true);
      const finalRevocation = sibling.decide(review.approvalDigest, false);
      const observed = reviews.observeDecision(review.approvalDigest);
      pending.push(reapproval, finalRevocation, observed);
      const settled = await Promise.all([
        revocation,
        reapproval,
        finalRevocation,
        observed.then((observedReceipt) => observedReceipt.value),
      ]);
      expect(settled).toEqual([review, review, review, { approved: false }]);
    } finally {
      await Promise.allSettled(pending);
    }
  });

  it("preserves review source while an earlier acknowledgement waits", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime = createRuntime(env);
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
    await entered.promise;
    const decision = reviews.decide(original.approvalDigest, true);
    const lookup = reviews.observeDecision(original.approvalDigest);
    const pending = reviews.list();
    env.OPENCLAW_STATE_DIR = redirectedDir;
    finish.resolve();

    try {
      await expect(request).resolves.toBeUndefined();
      await expect(decision).resolves.toEqual(original);
      await expect(lookup.then((receipt) => receipt.value)).resolves.toEqual({ approved: true });
      await expect(pending).resolves.toEqual([retained]);
      await expect(
        redirected.observeDecision(original.approvalDigest).then((receipt) => receipt.value),
      ).resolves.toEqual({
        approved: false,
      });
    } finally {
      finish.resolve();
      await Promise.allSettled([request, decision, lookup, pending]);
    }
  });

  it("fails when a delivered marker claim does not persist", async () => {
    const openKeyedStore = runtime.state.openKeyedStoreV2;
    runtime.state.openKeyedStoreV2 = <T>(
      options: OpenAsyncKeyedStoreOptions,
    ): PluginStateKeyedStore<T, 2> => {
      const store = openKeyedStore<T>(options);
      return options.namespace === REEF_DELIVERED_NAMESPACE
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    };

    await expect(new ReefDeliveredStore(runtime).confirm(receiptId)).rejects.toThrow(
      "Failed persisting Reef delivered marker",
    );
  });

  it("deduplicates concurrent pending reviews and evicts only completed decisions at capacity", async () => {
    const sql = observeHostDataSql();
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
    assertNoHostSql(sql.calls);
  });
});

describe("Reef delivered markers", () => {
  it("confirms delivered markers idempotently", async () => {
    const sql = observeHostDataSql().calls;
    const delivered = new ReefDeliveredStore(reopen());
    await expect(delivered.status("m1")).resolves.toBeUndefined();
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.confirm("m1");
    await expect(delivered.status("m1")).resolves.toBe("delivered");
    await delivered.confirm("m2");
    await expect(delivered.status("m2")).resolves.toBe("delivered");
    await expect(new ReefDeliveredStore(reopen()).status("m2")).resolves.toBe("delivered");
    assertNoHostSql(sql);
  });

  it("surfaces capacity as PLUGIN_STATE_LIMIT_EXCEEDED from confirm without touching existing markers", async () => {
    const stores = await openStores(reopen(), reefKeys(), {
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
