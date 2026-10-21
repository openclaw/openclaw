import { describe, expect, it } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import {
  inspectMainRestartRecoveryRolloverEligibility,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import { claimForeground, recoveryState } from "./main-session-recovery-state.test-support.js";

const sessionKey = "agent:main:main";

function interruptedEntry(
  overrides: Partial<SessionEntry> = {},
  recovery: Partial<MainRestartRecoveryState> = {},
): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(recovery),
    ...overrides,
  };
}

function observe(entry: SessionEntry, lifecycleGeneration: string) {
  const result = transitionMainSessionRecovery(entry, {
    kind: "observe",
    cycleId: "unused-cycle",
    lifecycleGeneration,
    sessionKey,
  });
  if (result.kind !== "observed") {
    throw new Error("expected recovery observation");
  }
  return result.view;
}

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

function admit(entry: SessionEntry, lifecycleGeneration = "generation-1") {
  return transitionMainSessionRecovery(entry, {
    kind: "admit_recovery",
    lifecycleGeneration,
    now: 300,
    runId: "recovery-1",
    sessionId: "session-1",
  });
}

describe("main session recovery state", () => {
  it("reserves an interrupted outcome from its recovery cycle without persisted liveness", () => {
    const entry = interruptedEntry({ status: "interrupted" });
    const view = observe(entry, "generation-1");
    expect(view.status).toBe("recoverable");
    if (view.status !== "recoverable") {
      throw new Error("expected recoverable claim");
    }
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: view.nextAttempt,
        lifecycleGeneration: "generation-1",
        now: 200,
        observation: view.observation,
        runId: "recovery-1",
        executionIdentity: { state: "disabled" },
      }).kind,
    ).toBe("reserved");
    expect(entry.status).toBe("interrupted");
  });

  it("allows rollover until the tombstone records its successor", () => {
    const entry = interruptedEntry({}, { tombstone: { reason: "exhausted" } });
    expect(inspectMainRestartRecoveryRolloverEligibility(entry)).toEqual({ eligible: true });
    entry.archivedAt = 101;
    expect(inspectMainRestartRecoveryRolloverEligibility(entry)).toEqual({ eligible: true });
    const successor = {
      recoveredSessionId: "recovered-id",
      recoveredSessionKey: "agent:main:dashboard:recovered",
    };
    entry.mainRestartRecovery!.tombstone = { reason: "exhausted", ...successor };
    expect(inspectMainRestartRecoveryRolloverEligibility(entry)).toEqual({
      eligible: false,
      reason: "already_recovered",
      ...successor,
    });
    expect(inspectMainRestartRecoveryRolloverEligibility(interruptedEntry())).toEqual({
      eligible: false,
      reason: "not_tombstoned",
    });
  });

  it("inspects a live reservation without adopting or releasing it", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: reservedState("gateway-generation"),
    });
    const before = structuredClone(entry);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "inspect",
        lifecycleGeneration: "standalone-generation",
        sessionKey,
      }),
    ).toEqual({ kind: "observed", view: { status: "blocked" } });
    expect(entry).toEqual(before);
  });

  it("marks without charging and replaces an older lifecycle owner for the same run", () => {
    const entry = interruptedEntry(
      {
        lifecycleRunId: "dead-run",
        lastRunId: "settled-run",
        restartRecoveryRuns: [fence("older-run", "generation-old"), fence("shared-run")],
      },
      {
        revision: 4,
        chargedAttempts: 2,
      },
    );

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "unused-cycle",
      now: 200,
      runs: [fence("shared-run", "generation-2"), fence("new-run", "generation-2")],
    });

    expect(entry.mainRestartRecovery).toEqual(
      recoveryState({
        revision: 4,
        chargedAttempts: 2,
      }),
    );
    expect(entry.restartRecoveryRuns).toEqual([
      fence("new-run", "generation-2"),
      fence("older-run", "generation-old"),
      fence("shared-run", "generation-2"),
    ]);
    expect(entry.lifecycleRunId).toBeUndefined();
    expect(entry.lastRunId).toBeUndefined();
  });

  it.each([false, true])("clears only fences with terminal evidence (terminal=%s)", (terminal) => {
    const entry = interruptedEntry({
      status: undefined,
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [
        fence("stale-run-1", "dead-generation-1"),
        fence("stale-run-2", "dead-generation-2"),
      ],
      restartRecoveryTerminalRunIds: terminal ? ["stale-run-1", "stale-run-2"] : undefined,
    });
    const fences = entry.restartRecoveryRuns;

    expect(claimForeground(entry)).toEqual({ kind: terminal ? "applied" : "no_change" });
    expect(entry.restartRecoveryRuns).toEqual(terminal ? undefined : fences);
    expect(entry.mainRestartRecovery).toBeUndefined();
    expect(entry.abortedLastRun).toBe(false);
  });

  it("keeps interrupted delivery custody authoritative regardless of the recorded outcome", () => {
    const entry = interruptedEntry({
      status: "failed",
      abortedLastRun: true,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: undefined,
      restartRecoveryDeliveryRunId: "pending-delivery",
    });

    expect(claimForeground(entry).kind).toBe("foreground_claimed");
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.mainRestartRecovery?.foregroundClaims?.tokens).toEqual(["foreground-1"]);
    // The delivery claim is owned by the delivery path, not recovery cleanup.
    expect(entry.restartRecoveryDeliveryRunId).toBe("pending-delivery");
  });

  it("keeps interrupted running recovery residue authoritative", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [fence("pending-run")],
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "cycle-2",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      }),
    ).toMatchObject({
      kind: "foreground_claimed",
    });
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.restartRecoveryRuns).toEqual([fence("pending-run")]);
    expect(entry.mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: claims(["foreground-1"]),
    });
  });

  it("keeps lifecycle fences while a recovery delivery owner remains", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryDeliveryRunId: "active-recovery",
      restartRecoveryRuns: [{ runId: "active-recovery", lifecycleGeneration: "generation-1" }],
    });
    const before = structuredClone(entry);

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry).toEqual(before);
  });

  it("retires a stale reservation before granting foreground ownership", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
        reservation: {
          attempt: 1,
          lifecycleGeneration: "previous-generation",
          runId: "stale-recovery",
        },
      }),
    });

    expect(claimForeground(entry)).toMatchObject({ kind: "foreground_claimed" });
    expect(entry.mainRestartRecovery).toMatchObject({
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
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
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "validate_recovery",
        lifecycleGeneration: "generation-1",
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "recovery_validated" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);

    expect(admit(entry)).toMatchObject({ kind: "admitted_recovery" });
    expect(entry).toMatchObject({
      abortedLastRun: false,
      pendingFinalDelivery: { kind: "replayable", text: " captured reply ", createdAt: 1 },
      restartRecoveryRuns: [fence("recovery-1")],
      mainRestartRecovery: {
        revision: 3,
        chargedAttempts: 1,
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(entry.lifecycleRunId).toBe("recovery-1");
    expect(entry.lastRunId).toBeUndefined();

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "mark_admitted_recovery_interrupted",
        cycleId: "cycle-1",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 400,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "applied" });
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
        {
          chargedAttempts: 1,
          ...(outcome === "started" ? { startedAttempt: 1 } : {}),
        },
      );
      const before = structuredClone(entry);

      expect(
        transitionMainSessionRecovery(entry, {
          kind: "mark_admitted_recovery_interrupted",
          cycleId: "cycle-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
          now: 400,
          runId: "recovery-1",
          sessionId: "session-1",
          unstartedOnly: true,
        }),
      ).toEqual({ kind: "rejected", reason: "stale_reservation" });
      expect(entry).toEqual(before);
    },
  );

  it.each([undefined, "interrupted"] as const)(
    "records an explicit interrupt of owed %s recovery without charging a retry",
    (status) => {
      const entry = interruptedEntry({
        status,
        restartRecoveryDeliverySourceRunId: "source-1",
      });

      expect(transitionMainSessionRecovery(entry, { kind: "interrupt_owed", now: 400 })).toEqual({
        kind: "applied",
      });
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
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
        },
        foregroundClaims: claims(["foreground-1", "foreground-2"]),
      },
    );

    expect(admit(entry)).toEqual({ kind: "rejected", reason: "foreground_active" });
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("clears a healthy recovery aggregate when its final foreground owner releases", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        restartRecoveryRuns: [fence("recovery-1")],
      },
      {
        revision: 3,
        chargedAttempts: 1,
        foregroundClaims: claims(["foreground-1"]),
      },
    );
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });

    expect(
      transitionMainSessionRecovery(entry, {
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
      {
        foregroundClaims: claims(["old-owner"], "generation-old"),
      },
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
      {
        foregroundClaims: claims(["old-owner"], "generation-old"),
      },
    );

    expect(observe(entry, "generation-new")).toEqual({ status: "inactive" });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("retains the charge but releases a reservation orphaned by process restart", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: reservedState("generation-old", { revision: 2 }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "observe",
        cycleId: "unused",
        lifecycleGeneration: "generation-new",
        sessionKey,
      }),
    ).toEqual({
      kind: "observed",
      view: {
        status: "recoverable",
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 3 },
        nextAttempt: 2,
      },
    });
    expect(entry.mainRestartRecovery).toMatchObject({
      revision: 3,
      chargedAttempts: 1,
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("preserves stored execution identity when a new lifecycle rotates the recovery run", () => {
    const storedToken = createExecutionIdentityAdmissionToken("recovery-old", {
      contextId: "context-1",
      executionId: "execution-1",
      now: 123,
    });
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({ executionIdentity: storedToken }),
    });

    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-new",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-new",
      executionIdentity: { state: "enabled" },
    });

    expect(prepared.kind).toBe("reserved");
    expect(entry.mainRestartRecovery?.executionIdentity).toBe(storedToken);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-new",
        now: 201,
        runId: "recovery-new",
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "admitted_recovery" });
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "bind_admitted_execution_identity",
        attempt: 1,
        cycleId: "cycle-1",
        lifecycleGeneration: "generation-new",
        runId: "recovery-new",
        sessionId: "session-1",
        token: storedToken,
      }),
    ).toEqual({ kind: "no_change" });
  });

  it("rejects an old observation after a healthy clear and a new interrupted cycle", () => {
    const entry = interruptedEntry();
    const oldObservation = { sessionId: "session-1", cycleId: "cycle-1", revision: 1 };
    transitionMainSessionRecovery(entry, { kind: "clear" });
    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "cycle-2",
      now: 400,
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 500,
        observation: oldObservation,
        runId: "stale-run",
        executionIdentity: { state: "disabled" },
      }),
    ).toEqual({ kind: "rejected", reason: "stale_cycle" });
  });

  it("preserves the charged cycle when an accepted recovery is interrupted again", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
      }),
    });

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "replacement-cycle",
      now: 300,
    });

    expect(entry.abortedLastRun).toBe(true);
    expect(entry.mainRestartRecovery).toEqual(
      recoveryState({
        revision: 3,
        chargedAttempts: 1,
      }),
    );
  });

  it("tombstones an exhausted cycle and exposes only the Doctor repair action", () => {
    const entry = interruptedEntry(
      {
        lifecycleRunId: "exhausted-run",
      },
      {
        chargedAttempts: 3,
      },
    );
    const view = observe(entry, "generation-1");
    expect(view.status).toBe("exhausted");
    if (view.status !== "exhausted") {
      throw new Error("expected exhausted cycle");
    }

    expect(
      transitionMainSessionRecovery(entry, {
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
    expect(transitionMainSessionRecovery(entry, { kind: "doctor_repair", now: 500 })).toEqual({
      kind: "doctor_repaired",
    });
    expect(entry.abortedLastRun).toBe(false);
  });

  it("owns lifecycle fence suppression, consumption, and healthy clearing", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery",
      restartRecoveryRuns: [fence("interrupted"), fence("recovery")],
    });
    expectApplied(
      entry,
      "interrupted",
      { status: "interrupted", abortedLastRun: true, endedAt: 200 },
      { status: "interrupted", abortedLastRun: true, endedAt: 200 },
      { data: { phase: "error", stopReason: "restart" } },
    );

    expectApplied(entry, "recovery", {
      status: "done",
      abortedLastRun: false,
      restartRecoveryRuns: undefined,
      mainRestartRecovery: undefined,
    });

    expectApplied(
      entry,
      "recovery",
      {
        status: "failed",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
      { status: "failed", abortedLastRun: false },
      { data: { phase: "error", error: "provider failed" } },
    );
  });

  it("does not let a delayed lifecycle event clear current-generation owners", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        restartRecoveryRuns: [fence("old-run")],
        restartRecoveryTerminalRunIds: ["prior-run"],
      },
      {
        foregroundClaims: claims(["current-owner"], "generation-2"),
      },
    );

    expectApplied(
      entry,
      "old-run",
      {
        restartRecoveryRuns: undefined,
        restartRecoveryTerminalRunIds: ["prior-run", "old-run"],
      },
      undefined,
      { currentLifecycleGeneration: "generation-2" },
    );
    expect(entry.mainRestartRecovery?.foregroundClaims?.tokens).toEqual(["current-owner"]);
  });

  it("does not let a delayed lifecycle event clear a current reservation", () => {
    const entry = interruptedEntry(
      {
        restartRecoveryRuns: [fence("old-run")],
      },
      {
        chargedAttempts: 1,
        reservation: {
          runId: "current-run",
          attempt: 1,
          lifecycleGeneration: "generation-2",
        },
      },
    );

    expectApplied(
      entry,
      "old-run",
      {
        restartRecoveryRuns: undefined,
        restartRecoveryTerminalRunIds: ["old-run"],
      },
      undefined,
      { currentLifecycleGeneration: "generation-2" },
    );
    expect(entry.mainRestartRecovery?.reservation?.runId).toBe("current-run");
  });

  it("preserves concurrent owners and fences when one lifecycle run completes", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        restartRecoveryRuns: [fence("recovery-1"), fence("recovery-2")],
      },
      {
        revision: 4,
        foregroundClaims: claims(["owner-1", "owner-2"]),
      },
    );

    expectApplied(
      entry,
      "recovery-1",
      {
        restartRecoveryRuns: [fence("recovery-2")],
        restartRecoveryTerminalRunIds: ["recovery-1"],
      },
      {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    );
  });

  it("does not let another terminal run clear the active recovery delivery", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-2",
      restartRecoveryRuns: [fence("recovery-1"), fence("recovery-2")],
    });

    expectApplied(entry, "recovery-1", {
      status: "done",
      abortedLastRun: false,
      restartRecoveryRuns: [fence("recovery-2")],
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });

  it("does not let an unrelated lifecycle completion clear pending recovery", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [fence("recovery")],
    });

    expect(
      projectLifecycle(entry, "ordinary-run", {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      }),
    ).toEqual({ action: "suppress" });
  });

  it("suppresses an unmatched completion while a current foreground owner is active", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
      },
      {
        foregroundClaims: claims(["current-owner"]),
      },
    );

    expect(projectLifecycle(entry, "unrelated-run")).toEqual({ action: "suppress" });
  });

  it("applies ordinary lifecycle completion without recovery metadata", () => {
    expectApplied({ abortedLastRun: false }, "ordinary-run", {
      status: "done",
      abortedLastRun: false,
    });
  });

  it("retires a normal start fence without clearing a killed run's aborted outcome", () => {
    expect(
      projectLifecycle(
        { restartRecoveryRuns: [{ runId: "ordinary-run", lifecycleGeneration: "generation-1" }] },
        "ordinary-run",
        { status: "killed", abortedLastRun: true },
        { data: { phase: "error", stopReason: "user" } },
      ),
    ).toEqual({
      action: "apply",
      patch: {
        status: "killed",
        abortedLastRun: true,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });
  });

  it("does not preserve foreground claims from an older lifecycle generation", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        restartRecoveryRuns: [fence("recovery", "generation-2")],
      },
      {
        foregroundClaims: claims(["stale-owner"]),
      },
    );

    expectApplied(
      entry,
      "recovery",
      {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
      undefined,
      { lifecycleGeneration: "generation-2" },
    );
  });

  it("does not let a delayed lifecycle event erase a recovery tombstone", () => {
    const entry = interruptedEntry(
      {
        abortedLastRun: false,
        status: "failed",
        restartRecoveryRuns: [fence("old-run")],
      },
      {
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    );

    expectApplied(entry, "old-run", {
      status: "done",
      abortedLastRun: false,
      restartRecoveryRuns: entry.restartRecoveryRuns,
      mainRestartRecovery: entry.mainRestartRecovery,
    });
  });
});
