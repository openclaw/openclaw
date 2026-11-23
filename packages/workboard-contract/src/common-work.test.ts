import { describe, expect, it } from "vitest";
import {
  CommonWorkAuthorityError,
  CommonWorkConflictError,
  addCommonWorkResources,
  admitCommonWork,
  applyCommonWorkAdminPatch,
  archiveCommonWork,
  assertCommonWorkBuildIdentity,
  assertCommonWorkFileDelivery,
  assertCommonWorkMutationSafety,
  assignCommonWorkSlots,
  attachCommonWorkExecution,
  checkpointCommonWork,
  closeCommonWork,
  commonWorkRootTitle,
  prepareManagedPublish,
  reconcileCommonWorkLedger,
  recordBoundedOutageEvidence,
  recordCommonWorkCallback,
  recordCommonWorkDelivery,
  recordCommonWorkRootSend,
  releaseCommonWorkResources,
  reserveCommonWorkRoute,
  reviseCommonWorkGoal,
  settleCommonWorkExecution,
  shouldPublishCommonWorkDecision,
  updateCommonWorkRoute,
  verifyManagedPublish,
  type CommonWorkAdmission,
  type CommonWorkRecord,
  type CommonWorkRoute,
} from "./index.js";

const route = (version = 1, threadId = "thread-1"): CommonWorkRoute => ({
  channelId: "channel-1",
  threadId,
  version,
});

const admission = (overrides: Partial<CommonWorkAdmission> = {}): CommonWorkAdmission => ({
  workId: "work-1",
  requestKey: "request-1",
  requestDigest: "digest-1",
  goal: "deliver result",
  objectiveDigest: "sha256:deliver-result",
  scope: ["common lifecycle"],
  acceptanceCriteria: ["result is delivered once"],
  reportingLeadAgentId: "lead",
  ownerAgentId: "dev",
  lane: "common",
  sourceSessionKey: "source-session",
  callbackSessionKey: "callback-session",
  userRoute: route(),
  routeFamily: "common-work",
  routeSequence: 1,
  now: 1,
  ...overrides,
});

const fresh = (overrides: Partial<CommonWorkAdmission> = {}): CommonWorkRecord =>
  admitCommonWork(admission(overrides)).record;

const running = (record = fresh(), generation = 1): CommonWorkRecord =>
  attachCommonWorkExecution(
    record,
    { executionId: "execution-" + generation, generation, sessionKey: "worker-" + generation },
    2,
  );

const terminal = (record = running()): CommonWorkRecord =>
  settleCommonWorkExecution(
    record,
    {
      executionId: record.execution!.executionId,
      generation: record.execution!.generation,
      status: "done",
      terminalReceipt: "terminal-1",
    },
    3,
  ).record;

describe("common work M1-M6 acceptance matrix", () => {
  it("T01 applies a receipt-backed user correction and rejects a separate goal", () => {
    const corrected = reviseCommonWorkGoal(
      fresh(),
      {
        goal: "corrected goal",
        objectiveDigest: "sha256:corrected-goal",
        scope: ["corrected scope"],
        acceptanceCriteria: ["corrected acceptance"],
        reportingLeadAgentId: "lead",
        source: "user_correction",
        correctionReceipt: "user:1",
      },
      2,
    );
    expect(corrected.workId).toBe("work-1");
    expect(corrected.scopeRevision).toBe(2);
    expect(() =>
      reviseCommonWorkGoal(
        corrected,
        {
          goal: "other goal",
          objectiveDigest: "sha256:other-goal",
          scope: ["other"],
          acceptanceCriteria: ["other"],
          reportingLeadAgentId: "lead",
          source: "separate_goal",
        },
        3,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T02 deduplicates a logical request without losing its identity", () => {
    const first = fresh();
    expect(admitCommonWork(admission(), first)).toEqual({ record: first, created: false });
    expect(() => admitCommonWork(admission({ requestDigest: "different" }), first)).toThrow(
      CommonWorkConflictError,
    );
  });

  it("T03 records a real worker session separately from the display route", () => {
    const record = running();
    expect(record.execution?.sessionKey).toBe("worker-1");
    expect(record.execution?.sessionKey).not.toBe(record.sourceSessionKey);
    expect(record.userRoute.threadId).toBe("thread-1");
  });

  it("T04 keeps route-family sequencing in the root title", () => {
    expect(commonWorkRootTitle(fresh(), "2026-11-22")).toBe("2026-11-22 · common-work · #1");
  });

  it("T05 allows one opener and reconciles unknown send results without resending", () => {
    const title = "2026-11-22 · common-work · #1";
    const reserved = reserveCommonWorkRoute(fresh(), "open-1", title, 2);
    const unknown = recordCommonWorkRootSend(reserved, { state: "unknown" }, 3);
    expect(unknown.routeOpen?.reconciliationRequired).toBe(true);
    expect(reserveCommonWorkRoute(unknown, "open-1", title, 4)).toBe(unknown);
    expect(() => reserveCommonWorkRoute(unknown, "open-2", title, 4)).toThrow(
      CommonWorkConflictError,
    );
  });

  it("T06 records the lead callback exactly once", () => {
    const done = terminal();
    const callback = recordCommonWorkCallback(
      done,
      { dedupeKey: "return-1", receipt: "callback-receipt", targetSessionKey: "callback-session" },
      4,
    );
    expect(
      recordCommonWorkCallback(
        callback,
        {
          dedupeKey: "return-1",
          receipt: "callback-receipt",
          targetSessionKey: "callback-session",
        },
        5,
      ),
    ).toBe(callback);
    expect(() =>
      recordCommonWorkCallback(
        callback,
        { dedupeKey: "return-2", receipt: "other", targetSessionKey: "callback-session" },
        5,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T07 admits one active worker for one request", () => {
    const active = running();
    expect(attachCommonWorkExecution(active, active.execution!, 3)).toBe(active);
    expect(() =>
      attachCommonWorkExecution(
        active,
        { executionId: "execution-2", generation: 2, sessionKey: "worker-2" },
        3,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T08 keeps source, callback, and user route as independent facts", () => {
    const record = fresh();
    expect(
      new Set([record.sourceSessionKey, record.callbackSessionKey, record.userRoute.threadId]).size,
    ).toBe(3);
    expect(() =>
      recordCommonWorkCallback(
        terminal(running(record)),
        { dedupeKey: "bad", receipt: "bad", targetSessionKey: record.sourceSessionKey },
        4,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T09 limits cross-owner correction to TO and current revision", () => {
    const record = fresh();
    expect(() =>
      applyCommonWorkAdminPatch(
        record,
        { actorRole: "dev", expectedRevision: 1, ownerAgentId: "uni" },
        2,
      ),
    ).toThrow(CommonWorkAuthorityError);
    const corrected = applyCommonWorkAdminPatch(
      record,
      { actorRole: "to", expectedRevision: 1, ownerAgentId: "uni" },
      2,
    );
    expect(corrected.ownerAgentId).toBe("uni");
    expect(() =>
      applyCommonWorkAdminPatch(corrected, { actorRole: "to", expectedRevision: 1 }, 3),
    ).toThrow(CommonWorkConflictError);
  });

  it("T10 keeps terminal, delivery, completion, and archive independent", () => {
    const done = terminal();
    expect(() => closeCommonWork(done, 4)).toThrow(CommonWorkConflictError);
    const callback = recordCommonWorkCallback(
      done,
      { dedupeKey: "return-1", receipt: "callback", targetSessionKey: "callback-session" },
      4,
    );
    const delivered = recordCommonWorkDelivery(
      callback,
      { route: route(), receipt: "delivery" },
      5,
    );
    const closed = closeCommonWork(delivered, 6);
    expect(closeCommonWork(closed, 7)).toBe(closed);
    const archiveFailed = archiveCommonWork(
      closed,
      { live: false, protectedSession: false, ownedByCaller: true, succeeded: false },
      7,
    );
    expect(archiveFailed.outcome).toBe("succeeded");
    expect(archiveFailed.archiveState).toBe("archive_failed");
  });

  it("T11 rejects a late result from an older generation", () => {
    const first = terminal();
    const second = attachCommonWorkExecution(
      first,
      { executionId: "execution-2", generation: 2, sessionKey: "worker-2" },
      4,
    );
    const late = settleCommonWorkExecution(
      second,
      { executionId: "execution-1", generation: 1, status: "done", terminalReceipt: "late" },
      5,
    );
    expect(late.accepted).toBe(false);
    expect(late.record.execution?.generation).toBe(2);
  });

  it("T12 deduplicates checkpoints and fences stale watchers", () => {
    const first = checkpointCommonWork(fresh(), { at: 30, generation: 1 });
    expect(checkpointCommonWork(first, { at: 30, generation: 1 })).toBe(first);
    const newer = checkpointCommonWork(first, { at: 60, generation: 2 });
    expect(checkpointCommonWork(newer, { at: 90, generation: 1 })).toBe(newer);
  });

  it("T13 refuses publisher drift and verifies apply or exact rollback", () => {
    const digest = (value: string) => "digest:" + value;
    expect(() =>
      prepareManagedPublish({
        prior: "<!--managed-->old",
        next: "<!--managed-->new",
        observedPriorDigest: "wrong",
        digest,
        marker: "<!--managed-->",
      }),
    ).toThrow(CommonWorkConflictError);
    const plan = prepareManagedPublish({
      prior: "<!--managed-->old",
      next: "<!--managed-->new",
      observedPriorDigest: digest("<!--managed-->old"),
      digest,
      marker: "<!--managed-->",
    });
    expect(verifyManagedPublish(plan, plan.next, digest)).toBe("applied");
    expect(verifyManagedPublish(plan, plan.prior, digest)).toBe("rolled_back");
  });

  it("T14 releases only resources owned by the work", () => {
    const allocated = addCommonWorkResources(fresh(), ["worker:1", "temp:1", "worker:1"], 2);
    const released = releaseCommonWorkResources(allocated, 3);
    expect(released.resources).toEqual([]);
    expect(released.releasedResources).toEqual(["worker:1", "temp:1"]);
    expect(releaseCommonWorkResources(released, 4)).toBe(released);
  });

  it("T15 blocks mutation on cap, identity, protection, or omission failure", () => {
    expect(() =>
      assertCommonWorkMutationSafety({
        identityMatches: true,
        omissions: 1,
        protectedSourceTouched: false,
        remainingRatio: 0.2,
        minimumRemainingRatio: 0.15,
      }),
    ).toThrow(CommonWorkConflictError);
    expect(() =>
      assertCommonWorkMutationSafety({
        identityMatches: true,
        omissions: 0,
        protectedSourceTouched: false,
        remainingRatio: 0.2,
        minimumRemainingRatio: 0.15,
      }),
    ).not.toThrow();
  });

  it("T16 protects both specialist and common opportunity while borrowing idle slots", () => {
    const pending = [
      { workId: "common-1", lane: "common" as const, admittedAt: 1 },
      { workId: "common-2", lane: "common" as const, admittedAt: 2 },
      { workId: "uni-1", lane: "uni" as const, admittedAt: 3 },
      { workId: "luke-1", lane: "luke" as const, admittedAt: 4 },
    ];
    const selected = assignCommonWorkSlots(pending, []);
    expect(selected).toHaveLength(3);
    expect(selected.some((item) => item.lane === "common")).toBe(true);
    expect(selected.some((item) => item.lane !== "common")).toBe(true);
    expect(assignCommonWorkSlots(pending.slice(0, 2), [])).toHaveLength(2);
    expect(assignCommonWorkSlots([pending[0]!, pending[0]!], [])).toEqual([pending[0]]);
  });

  it("T17 publishes only accepted and implemented decisions", () => {
    expect(shouldPublishCommonWorkDecision({ status: "draft", implementationComplete: true })).toBe(
      false,
    );
    expect(
      shouldPublishCommonWorkDecision({ status: "accepted", implementationComplete: false }),
    ).toBe(false);
    expect(
      shouldPublishCommonWorkDecision({ status: "accepted", implementationComplete: true }),
    ).toBe(true);
  });

  it("T18 verifies outbox path, bytes, and digest", () => {
    expect(() =>
      assertCommonWorkFileDelivery({
        path: "/delivery/outbox/result.txt",
        reportedBytes: 4,
        actualBytes: 4,
        reportedDigest: "d",
        actualDigest: "d",
      }),
    ).not.toThrow();
    expect(() =>
      assertCommonWorkFileDelivery({
        path: "/legacy/inbox/result.txt",
        reportedBytes: 4,
        actualBytes: 4,
        reportedDigest: "d",
        actualDigest: "d",
      }),
    ).toThrow(CommonWorkConflictError);
  });

  it("T19 requires one build identity across user-visible paths", () => {
    expect(() =>
      assertCommonWorkBuildIdentity({
        candidateBuildId: "a",
        uiBuildId: "b",
        httpReady: true,
        websocketReady: true,
        channelReady: true,
      }),
    ).toThrow(CommonWorkConflictError);
    expect(() =>
      assertCommonWorkBuildIdentity({
        candidateBuildId: "a",
        uiBuildId: "a",
        httpReady: true,
        websocketReady: true,
        channelReady: true,
      }),
    ).not.toThrow();
  });

  it("T20 rejects a delivery receipt for a superseded thread", () => {
    const current = updateCommonWorkRoute(terminal(), route(2, "thread-2"), 4);
    const callback = recordCommonWorkCallback(
      current,
      { dedupeKey: "return", receipt: "callback", targetSessionKey: "callback-session" },
      5,
    );
    expect(() => recordCommonWorkDelivery(callback, { route: route(), receipt: "old" }, 6)).toThrow(
      CommonWorkConflictError,
    );
    const delivered = recordCommonWorkDelivery(
      callback,
      { route: route(2, "thread-2"), receipt: "new" },
      6,
    );
    expect(delivered.deliveryReceipt).toBe("new");
    const redirected = updateCommonWorkRoute(delivered, route(3, "thread-3"), 7);
    expect(redirected.deliveryReceipt).toBeUndefined();
    expect(redirected.responsibility).toBe("delivery_pending");
  });

  it("T21 preserves bounded evidence during a ledger outage", () => {
    const state = recordBoundedOutageEvidence(
      { mode: "normal", evidence: [], pendingReconciliation: ["work-1"] },
      "read-only-design",
    );
    expect(state).toEqual({
      mode: "bounded_read_only",
      evidence: ["read-only-design"],
      pendingReconciliation: ["work-1"],
    });
  });

  it("T22 reconciles the same logical work once after recovery", () => {
    const initial = {
      mode: "bounded_read_only" as const,
      evidence: ["e"],
      pendingReconciliation: ["work-1", "work-2"],
    };
    const once = reconcileCommonWorkLedger(initial, "work-1");
    expect(once.pendingReconciliation).toEqual(["work-2"]);
    expect(once.mode).toBe("bounded_read_only");
    expect(reconcileCommonWorkLedger(once, "work-2").mode).toBe("normal");
  });

  it("T23 refuses archive for live, protected, or foreign sessions", () => {
    for (const input of [
      { live: true, protectedSession: false, ownedByCaller: true, succeeded: true },
      { live: false, protectedSession: true, ownedByCaller: true, succeeded: true },
      { live: false, protectedSession: false, ownedByCaller: false, succeeded: true },
    ]) {
      expect(() => archiveCommonWork(fresh(), input, 2)).toThrow(CommonWorkAuthorityError);
    }
  });

  it("T24 drains the admitted execution without losing callback or route identity", () => {
    const admitted = running();
    const done = terminal(admitted);
    const callback = recordCommonWorkCallback(
      done,
      { dedupeKey: "return", receipt: "callback", targetSessionKey: "callback-session" },
      4,
    );
    const delivered = recordCommonWorkDelivery(
      callback,
      { route: route(), receipt: "delivery" },
      5,
    );
    expect(delivered.execution?.executionId).toBe(admitted.execution?.executionId);
    expect(delivered.callbackSessionKey).toBe("callback-session");
    expect(delivered.userRoute).toEqual(route());
  });
});
