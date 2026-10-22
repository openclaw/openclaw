import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { transitionMainSessionRecovery as transition } from "./main-session-recovery-state.js";
import {
  claimForeground,
  executionIdentity,
  recoveryEntry,
  recoveryState,
} from "./main-session-recovery-state.test-support.js";
import type { MainSessionRecoveryCommand } from "./main-session-recovery-types.js";

const run = {
  cycleId: "cycle-1",
  lifecycleGeneration: "generation-1",
  runId: "recovery-1",
  sessionId: "session-1",
};
function prepare(
  entry: SessionEntry,
  overrides: Partial<Extract<MainSessionRecoveryCommand, { kind: "prepare_attempt" }>> = {},
) {
  return transition(entry, {
    ...run,
    kind: "prepare_attempt",
    attempt: 1,
    now: 200,
    observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
    executionIdentity: { state: "enabled" },
    ...overrides,
  });
}
function admit(entry: SessionEntry, now: number) {
  return transition(entry, { ...run, kind: "admit_recovery", now });
}
function interrupt(entry: SessionEntry, attempt: number, now: number) {
  return transition(entry, { ...run, kind: "mark_admitted_recovery_interrupted", attempt, now });
}
function bind(entry: SessionEntry) {
  return transition(entry, {
    ...run,
    kind: "bind_admitted_execution_identity",
    attempt: 1,
    token: executionIdentity(run.runId),
  });
}

function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return recoveryEntry({ status: "interrupted", abortedLastRun: true, ...overrides });
}

function observe(entry: SessionEntry, lifecycleGeneration: string) {
  const result = transition(entry, {
    kind: "observe",
    cycleId: "unused-cycle",
    lifecycleGeneration,
    sessionKey: "agent:main:main",
  });
  assert(result.kind === "observed", "expected recovery observation");
  return result.view;
}

describe("main session recovery execution identity state", () => {
  it("refreshes the budget only after a runtime turn starts", () => {
    const entry = interruptedEntry();
    for (let attempt = 1; attempt <= 7; attempt++) {
      const view = observe(entry, "generation-1");
      assert(view.status === "recoverable", "expected a recoverable session");
      expect(view.nextAttempt).toBe(attempt);
      expect(
        prepare(entry, { attempt, now: 200 + attempt, observation: view.observation }).kind,
      ).toBe("reserved");
      expect(admit(entry, 300 + attempt).kind).toBe("admitted_recovery");
      if (attempt <= 4) {
        const registration = { kind: "register_recovery_turn" as const, attempt, ...run };
        transition(entry, {
          ...registration,
          kind: "bind_admitted_execution_identity",
          token: executionIdentity("recovery-1"),
        });
        expect(transition(entry, registration).kind).toBe("applied");
        expect(transition(entry, registration).kind).toBe("no_change");
      }
      interrupt(entry, attempt, 400 + attempt);
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
    const prepared = prepare(entry);
    assert(prepared.kind === "reserved", "expected reservation");
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();

    expect(prepare(entry, { now: 201, runId: "recovery-2" })).toEqual({
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
      foregroundClaims: { lifecycleGeneration: "generation-1", tokens: ["foreground-1"] },
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

    const prepared = prepare(entry, { executionIdentity: { state: "disabled" } });

    expect(prepared.kind).toBe("reserved");
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind from an older cycle that reused the public run id", () => {
    const entry = interruptedEntry({
      status: undefined,
      abortedLastRun: false,
      lifecycleRunId: "recovery-1",
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({ cycleId: "cycle-2" }),
    });

    expect(bind(entry)).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind after a newer disabled attempt reuses the run", () => {
    const entry = interruptedEntry();
    expect(prepare(entry).kind).toBe("reserved");
    expect(admit(entry, 220)).toMatchObject({ kind: "admitted_recovery" });
    expect(interrupt(entry, 1, 230)).toEqual({ kind: "applied" });
    const second = prepare(entry, {
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
    expect(admit(entry, 250)).toMatchObject({ kind: "admitted_recovery" });

    expect(bind(entry)).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });
});
