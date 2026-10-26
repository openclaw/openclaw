import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery as transition } from "./main-session-recovery-state.js";
import {
  admitRecoveryAttempt,
  claimForeground,
  executionIdentity,
  interruptedRecoveryEntry as interruptedEntry,
  interruptRecoveryAttempt as interrupt,
  observeRecovery as observe,
  prepareRecoveryAttempt as prepare,
  recoveryRun as run,
  recoveryState,
} from "./main-session-recovery-state.test-support.js";

const sessionKey = "agent:main:main";

const settled = {
  status: "done" as const,
  abortedLastRun: false,
  restartRecoveryRuns: undefined,
  mainRestartRecovery: undefined,
};

type LifecycleProjectionParams = Parameters<typeof projectMainSessionRecoveryLifecycle>[0];
type LifecycleOptions = Partial<Pick<LifecycleProjectionParams, "currentLifecycleGeneration">> &
  Partial<LifecycleProjectionParams["event"]>;

function projectLifecycle(
  entry: LifecycleProjectionParams["entry"],
  runId: string,
  snapshotPatch: LifecycleProjectionParams["snapshotPatch"] = {
    status: "done",
    abortedLastRun: false,
  },
  {
    lifecycleGeneration = "generation-1",
    currentLifecycleGeneration = lifecycleGeneration,
    data = { phase: "end" },
  }: LifecycleOptions = {},
) {
  return projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration,
    entry,
    event: { runId, lifecycleGeneration, data },
    snapshotPatch,
  });
}

function expectApplied(
  entry: LifecycleProjectionParams["entry"],
  runId: string,
  patch: LifecycleProjectionParams["snapshotPatch"],
  snapshotPatch?: LifecycleProjectionParams["snapshotPatch"],
  options?: LifecycleOptions,
) {
  expect(projectLifecycle(entry, runId, snapshotPatch, options)).toEqual({
    action: "apply",
    patch,
  });
}

function fence(runId: string, lifecycleGeneration = "generation-1") {
  return { runId, lifecycleGeneration };
}

function claims(tokens: string[], lifecycleGeneration = "generation-1") {
  return { lifecycleGeneration, tokens };
}

function reservedState(
  lifecycleGeneration = "generation-1",
  overrides: Partial<MainRestartRecoveryState> = {},
) {
  return recoveryState({
    chargedAttempts: 1,
    reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration },
    ...overrides,
  });
}

function lifecycleEntry(
  runIds: string[],
  recovery: Partial<MainRestartRecoveryState> = {},
  overrides: Partial<SessionEntry> = {},
) {
  return interruptedEntry(
    {
      abortedLastRun: false,
      restartRecoveryRuns: runIds.map((runId) => fence(runId)),
      ...overrides,
    },
    recovery,
  );
}

function admit(entry: SessionEntry, lifecycleGeneration = "generation-1") {
  return admitRecoveryAttempt(entry, 300, lifecycleGeneration);
}

describe("main session recovery state", () => {
  it("inspects a live reservation without adopting or releasing it", () => {
    const entry = interruptedEntry({ mainRestartRecovery: reservedState("gateway-generation") });
    const before = structuredClone(entry);

    expect(
      transition(entry, {
        kind: "inspect",
        lifecycleGeneration: "standalone-generation",
        sessionKey,
      }),
    ).toEqual({ kind: "observed", view: { status: "blocked" } });
    expect(entry).toEqual(before);
  });

  it.each([
    {
      name: "preserves unfinished fences without an aggregate",
      entry: interruptedEntry({
        status: undefined,
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [
          fence("stale-run-1", "dead-generation-1"),
          fence("stale-run-2", "dead-generation-2"),
        ],
      }),
      result: { kind: "no_change" },
      expected: { abortedLastRun: false, mainRestartRecovery: undefined },
    },
    {
      name: "preserves interrupted delivery custody despite a failed outcome",
      entry: interruptedEntry({
        status: "failed",
        mainRestartRecovery: undefined,
        restartRecoveryRuns: undefined,
        restartRecoveryDeliveryRunId: "pending-delivery",
      }),
      result: expect.objectContaining({ kind: "foreground_claimed" }),
      expected: {
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "pending-delivery",
        mainRestartRecovery: { foregroundClaims: { tokens: ["foreground-1"] } },
      },
    },
    {
      name: "creates recovery identity without discarding interrupted running custody",
      entry: interruptedEntry({
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [fence("pending-run")],
      }),
      result: expect.objectContaining({ kind: "foreground_claimed" }),
      expected: {
        abortedLastRun: true,
        mainRestartRecovery: { cycleId: "cycle-2", foregroundClaims: claims(["foreground-1"]) },
      },
    },
    {
      name: "retires a stale reservation before granting foreground ownership",
      entry: interruptedEntry({}, reservedState("previous-generation", { revision: 3 })),
      result: expect.objectContaining({ kind: "foreground_claimed" }),
      expected: {
        mainRestartRecovery: {
          chargedAttempts: 1,
          reservation: undefined,
          foregroundClaims: claims(["foreground-1"]),
        },
      },
    },
  ])("$name", ({ entry, result, expected }) => {
    const runs = structuredClone(entry.restartRecoveryRuns);
    expect(
      transition(entry, {
        kind: "claim_foreground",
        cycleId: "cycle-2",
        sessionKey,
        sessionId: "session-1",
        lifecycleGeneration: "generation-1",
        claimId: "foreground-1",
      }),
    ).toEqual(result);
    expect(entry).toMatchObject(expected);
    expect(entry.restartRecoveryRuns).toEqual(runs);
  });

  it("moves a reservation into the lifecycle fence during Gateway admission", () => {
    const entry = interruptedEntry({
      lastRunId: "settled-run",
      pendingFinalDelivery: { kind: "replayable", text: " captured reply ", createdAt: 1 },
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryRuns: [fence("recovery-1", "generation-old")],
      mainRestartRecovery: reservedState("generation-1", { revision: 2 }),
    });
    expect(transition(entry, { ...run, kind: "validate_recovery" })).toEqual({
      kind: "recovery_validated",
    });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);

    expect(admit(entry)).toMatchObject({ kind: "admitted_recovery" });
    expect(entry).toMatchObject({
      abortedLastRun: false,
      pendingFinalDelivery: { kind: "replayable", text: " captured reply ", createdAt: 1 },
      restartRecoveryRuns: [fence("recovery-1")],
      mainRestartRecovery: { revision: 3, chargedAttempts: 1 },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(entry.lifecycleRunId).toBe("recovery-1");
    expect(entry.lastRunId).toBeUndefined();

    expect(interrupt(entry)).toMatchObject({ kind: "applied" });
    expect(entry.mainRestartRecovery?.chargedAttempts).toBe(1);
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entry.restartRecoveryDeliverySourceRunId).toBe("source-1");
    expect(entry.lifecycleRunId).toBeUndefined();
    expect(entry.lastRunId).toBeUndefined();
  });

  it.each(["started", "terminal"] as const)(
    "does not restore a %s recovery attempt during pre-start cleanup",
    (outcome) => {
      const entry = interruptedEntry(
        {
          status: undefined,
          abortedLastRun: false,
          lifecycleRunId: "recovery-1",
          restartRecoveryDeliveryRunId: "recovery-1",
          restartRecoveryRuns: [fence("recovery-1")],
          ...(outcome === "terminal" ? { restartRecoveryTerminalRunIds: ["recovery-1"] } : {}),
        },
        { chargedAttempts: 1, ...(outcome === "started" ? { startedAttempt: 1 } : {}) },
      );
      const before = structuredClone(entry);

      expect(interrupt(entry, { unstartedOnly: true })).toEqual({
        kind: "rejected",
        reason: "stale_reservation",
      });
      expect(entry).toEqual(before);
    },
  );

  it.each([undefined, "interrupted"] as const)(
    "records an explicit interrupt of owed %s recovery without charging a retry",
    (status) => {
      const entry = interruptedEntry({ status, restartRecoveryDeliverySourceRunId: "source-1" });

      expect(transition(entry, { kind: "interrupt_owed", now: 400 })).toEqual({ kind: "applied" });
      expect(entry).toMatchObject({ status: "killed", endedAt: 400, abortedLastRun: false });
      expect(entry.mainRestartRecovery).toBeUndefined();
      expect(entry.restartRecoveryDeliverySourceRunId).toBeUndefined();
      expect(entry.restartRecoveryTerminalRunIds).toContain("source-1");
    },
  );

  it("rejects a reservation created by an older lifecycle generation", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: reservedState("generation-old", { revision: 2 }),
    });

    expect(admit(entry, "generation-new")).toEqual({
      kind: "rejected",
      reason: "stale_reservation",
    });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);
  });

  it("rejects recovery admission while any current-generation foreground claim remains", () => {
    const entry = interruptedEntry(
      {},
      {
        revision: 4,
        chargedAttempts: 1,
        reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration: "generation-1" },
        foregroundClaims: claims(["foreground-1", "foreground-2"]),
      },
    );

    expect(admit(entry)).toEqual({ kind: "rejected", reason: "foreground_active" });
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("clears a healthy recovery aggregate when its final foreground owner releases", () => {
    const entry = interruptedEntry(
      { abortedLastRun: false, restartRecoveryRuns: [fence("recovery-1")] },
      { revision: 3, chargedAttempts: 1, foregroundClaims: claims(["foreground-1"]) },
    );
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });

    expect(
      transition(entry, {
        kind: "release_foreground",
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
        },
      }),
    ).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({ abortedLastRun: false });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("expires foreground claims from an older lifecycle generation", () => {
    const entry = interruptedEntry(
      {},
      { foregroundClaims: claims(["old-owner"], "generation-old") },
    );

    const view = observe(entry, "generation-new");

    expect(view).toMatchObject({ status: "recoverable", nextAttempt: 1 });
    expect(entry.mainRestartRecovery).toMatchObject({ revision: 2 });
    expect(entry.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("clears a healthy aggregate owned by an older lifecycle generation", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        restartRecoveryRuns: [fence("completed-run", "generation-old")],
      },
      { foregroundClaims: claims(["old-owner"], "generation-old") },
    );

    expect(observe(entry, "generation-new")).toEqual({ status: "inactive" });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("retains the charge but releases a reservation orphaned by process restart", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: reservedState("generation-old", { revision: 2 }),
    });

    expect(observe(entry, "generation-new")).toEqual({
      status: "recoverable",
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 3 },
      nextAttempt: 2,
    });
    expect(entry.mainRestartRecovery).toMatchObject({ revision: 3, chargedAttempts: 1 });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("rejects an old observation after a healthy clear and a new interrupted cycle", () => {
    const entry = interruptedEntry();
    const oldObservation = { sessionId: "session-1", cycleId: "cycle-1", revision: 1 };
    transition(entry, { kind: "clear" });
    transition(entry, { kind: "mark_interrupted", cycleId: "cycle-2", now: 400 });

    expect(prepare(entry, { now: 500, observation: oldObservation, runId: "stale-run" })).toEqual({
      kind: "rejected",
      reason: "stale_cycle",
    });
  });

  it("tombstones an exhausted cycle and exposes only the Doctor repair action", () => {
    const entry = interruptedEntry({ lifecycleRunId: "exhausted-run" }, { chargedAttempts: 3 });
    const view = observe(entry, "generation-1");
    assert(view.status === "exhausted", "expected exhausted cycle");

    expect(
      transition(entry, {
        kind: "tombstone",
        now: 400,
        observation: view.observation,
        reason: view.reason,
      }),
    ).toEqual({ kind: "tombstoned" });
    expect(entry.mainRestartRecovery?.tombstone?.reason).toBe(view.reason);
    expect(entry.lifecycleRunId).toBeUndefined();
    expect(observe(entry, "generation-1")).toEqual({ status: "tombstoned" });

    entry.abortedLastRun = true;
    expect(transition(entry, { kind: "doctor_repair", now: 500 })).toEqual({
      kind: "doctor_repaired",
    });
    expect(entry.abortedLastRun).toBe(false);
  });

  it.each<[string, ...Parameters<typeof expectApplied>]>([
    [
      "accepts the owning restart interruption",
      lifecycleEntry(["interrupted", "recovery"], {}, { restartRecoveryDeliveryRunId: "recovery" }),
      "interrupted",
      { status: "interrupted", abortedLastRun: true, endedAt: 200 },
      { status: "interrupted", abortedLastRun: true, endedAt: 200 },
      { data: { phase: "error", stopReason: "restart" } },
    ],
    [
      "clears healthy recovery",
      lifecycleEntry(["interrupted", "recovery"], {}, { restartRecoveryDeliveryRunId: "recovery" }),
      "recovery",
      settled,
    ],
    [
      "clears failed recovery",
      lifecycleEntry(["interrupted", "recovery"], {}, { restartRecoveryDeliveryRunId: "recovery" }),
      "recovery",
      { ...settled, status: "failed" },
      { status: "failed", abortedLastRun: false },
      { data: { phase: "error", error: "provider failed" } },
    ],
    [
      "preserves current foreground owners on delayed completion",
      lifecycleEntry(
        ["old-run"],
        { foregroundClaims: claims(["current-owner"], "generation-2") },
        { restartRecoveryTerminalRunIds: ["prior-run"] },
      ),
      "old-run",
      { restartRecoveryRuns: undefined, restartRecoveryTerminalRunIds: ["prior-run", "old-run"] },
      undefined,
      { currentLifecycleGeneration: "generation-2" },
    ],
    [
      "preserves current reservations on delayed completion",
      interruptedEntry(
        { restartRecoveryRuns: [fence("old-run")] },
        {
          chargedAttempts: 1,
          reservation: { runId: "current-run", attempt: 1, lifecycleGeneration: "generation-2" },
        },
      ),
      "old-run",
      { restartRecoveryRuns: undefined, restartRecoveryTerminalRunIds: ["old-run"] },
      undefined,
      { currentLifecycleGeneration: "generation-2" },
    ],
    [
      "preserves concurrent owners and fences",
      lifecycleEntry(["recovery-1", "recovery-2"], {
        revision: 4,
        foregroundClaims: claims(["owner-1", "owner-2"]),
      }),
      "recovery-1",
      { restartRecoveryRuns: [fence("recovery-2")], restartRecoveryTerminalRunIds: ["recovery-1"] },
      settled,
    ],

    [
      "preserves the killed run's aborted outcome",
      { restartRecoveryRuns: [fence("ordinary-run")] },
      "ordinary-run",
      { ...settled, status: "killed", abortedLastRun: true },
      { status: "killed", abortedLastRun: true },
      { data: { phase: "error", stopReason: "user" } },
    ],
    [
      "retires older-generation foreground claims",
      interruptedEntry(
        {
          abortedLastRun: false,
          restartRecoveryRuns: [fence("recovery", "generation-2")],
        },
        { foregroundClaims: claims(["stale-owner"]) },
      ),
      "recovery",
      settled,
      undefined,
      { lifecycleGeneration: "generation-2" },
    ],
  ])("%s", (_name, entry, runId, patch, snapshotPatch, options) => {
    const before = structuredClone(entry);
    expectApplied(entry, runId, patch, snapshotPatch, options);
    // Projection must not mutate retained owners or reservations.
    expect(entry).toEqual(before);
  });

  it.each([
    [
      "pending recovery",
      interruptedEntry({ restartRecoveryRuns: [fence("recovery")] }),
      "ordinary-run",
      settled,
    ],
    [
      "current foreground owner",
      interruptedEntry({ abortedLastRun: false }, { foregroundClaims: claims(["current-owner"]) }),
      "unrelated-run",
      undefined,
    ],
  ] satisfies Array<
    [string, Parameters<typeof projectLifecycle>[0], string, Parameters<typeof projectLifecycle>[2]]
  >)("suppresses unmatched completion with %s", (_name, entry, runId, snapshotPatch) => {
    expect(projectLifecycle(entry, runId, snapshotPatch)).toEqual({ action: "suppress" });
  });

  it("does not let another terminal run clear the active recovery delivery", () => {
    const entry = lifecycleEntry(
      ["recovery-1", "recovery-2"],
      {},
      {
        restartRecoveryDeliveryRunId: "recovery-2",
      },
    );
    expectApplied(entry, "recovery-1", {
      ...settled,
      restartRecoveryRuns: [fence("recovery-2")],
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });

  it("does not let a delayed lifecycle event erase a recovery tombstone", () => {
    const entry = lifecycleEntry(
      ["old-run"],
      { revision: 4, chargedAttempts: 3, tombstone: { reason: "automatic recovery exhausted" } },
      { status: "failed" },
    );
    expectApplied(entry, "old-run", {
      ...settled,
      restartRecoveryRuns: entry.restartRecoveryRuns,
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });
});

function prepareEnabled(
  entry: SessionEntry,
  overrides: NonNullable<Parameters<typeof prepare>[1]> = {},
) {
  return prepare(entry, { executionIdentity: { state: "enabled" }, ...overrides });
}

function bind(entry: SessionEntry) {
  return transition(entry, {
    ...run,
    kind: "bind_admitted_execution_identity",
    attempt: 1,
    token: executionIdentity(run.runId),
  });
}

describe("main session recovery execution identity state", () => {
  it("refreshes the budget only after a runtime turn starts", () => {
    const entry = interruptedEntry();
    for (let attempt = 1; attempt <= 7; attempt++) {
      const view = observe(entry, "generation-1");
      assert(view.status === "recoverable", "expected a recoverable session");
      expect(view.nextAttempt).toBe(attempt);
      expect(
        prepareEnabled(entry, { attempt, now: 200 + attempt, observation: view.observation }).kind,
      ).toBe("reserved");
      expect(entry.status).toBe("interrupted");
      expect(admitRecoveryAttempt(entry, 300 + attempt).kind).toBe("admitted_recovery");
      if (attempt <= 4) {
        const registration = { kind: "register_recovery_turn" as const, attempt, ...run };
        const binding = {
          ...registration,
          kind: "bind_admitted_execution_identity" as const,
          token: executionIdentity("recovery-1"),
        };
        transition(entry, binding);
        expect(transition(entry, binding)).toEqual({ kind: "no_change" });
        expect(transition(entry, registration).kind).toBe("applied");
        expect(transition(entry, registration).kind).toBe("no_change");
      }
      interrupt(entry, { attempt, now: 400 + attempt });
    }
    expect(observe(entry, "generation-1")).toMatchObject({ status: "exhausted" });
    expect(entry.mainRestartRecovery).toMatchObject({ chargedAttempts: 7, startedAttempt: 4 });
    expect(entry.mainRestartRecovery?.executionIdentity).toEqual(executionIdentity("recovery-1"));
    expect(transition(entry, { kind: "register_recovery_turn", attempt: 4, ...run })).toEqual({
      kind: "rejected",
      reason: "stale_reservation",
    });
    expect(observe(entry, "generation-1")).toMatchObject({ status: "exhausted" });
  });

  it("keeps reservation identity-free and cancellation leaves no identity state", () => {
    const entry = interruptedEntry();
    const prepared = prepareEnabled(entry);
    assert(prepared.kind === "reserved", "expected reservation");
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();

    expect(prepareEnabled(entry, { now: 201, runId: "recovery-2" })).toEqual({
      kind: "rejected",
      reason: "stale_revision",
    });
    expect(entry.mainRestartRecovery?.reservation).toMatchObject({
      runId: "recovery-1",
      attempt: 1,
    });

    expect(claimForeground(entry).kind).toBe("foreground_claimed");
    expect(
      transition(entry, { kind: "cancel_reservation", reservation: prepared.reservation }),
    ).toEqual({ kind: "applied" });
    expect(entry.mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: claims(["foreground-1"]),
      reservation: undefined,
      executionIdentity: undefined,
    });
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("does not propagate a previously retained token while collection is disabled", () => {
    const retained = executionIdentity("recovery-1");
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({ executionIdentity: retained }),
    });

    const prepared = prepareEnabled(entry, { executionIdentity: { state: "disabled" } });

    expect(prepared.kind).toBe("reserved");
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind from an older cycle that reused the public run id", () => {
    const entry = interruptedEntry({
      status: undefined,
      abortedLastRun: false,
      lifecycleRunId: "recovery-1",
      restartRecoveryRuns: [fence("recovery-1")],
      mainRestartRecovery: recoveryState({ cycleId: "cycle-2" }),
    });

    expect(bind(entry)).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind after a newer disabled attempt reuses the run", () => {
    const entry = interruptedEntry();
    expect(prepareEnabled(entry).kind).toBe("reserved");
    expect(admitRecoveryAttempt(entry, 220)).toMatchObject({ kind: "admitted_recovery" });
    expect(interrupt(entry, { attempt: 1, now: 230 })).toEqual({ kind: "applied" });
    const second = prepareEnabled(entry, {
      attempt: 2,
      now: 240,
      observation: {
        sessionId: "session-1",
        cycleId: "cycle-1",
        revision: entry.mainRestartRecovery!.revision,
      },
      executionIdentity: { state: "disabled" },
    });
    expect(second.kind).toBe("reserved");
    expect(admitRecoveryAttempt(entry, 250)).toMatchObject({ kind: "admitted_recovery" });

    expect(bind(entry)).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });
});
