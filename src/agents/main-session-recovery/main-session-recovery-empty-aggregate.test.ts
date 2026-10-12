import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

const sessionKey = "agent:main:main";
function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return { cycleId: "cycle-1", revision: 1, chargedAttempts: 0, ...overrides };
}
function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    abortedLastRun: false,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}
function claimForeground(
  session: SessionEntry,
  options: { sessionId?: string; sessionKey?: string; runId?: string } = {},
) {
  return transitionMainSessionRecovery(session, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: options.sessionId ?? "session-1",
    sessionKey: options.sessionKey ?? sessionKey,
    claimId: "foreground-1",
    runId: options.runId,
  });
}

const ownershipControls: Array<{
  label: string;
  state: Partial<MainRestartRecoveryState>;
  entry?: Partial<SessionEntry>;
}> = [
  { label: "a charged attempt", state: { chargedAttempts: 1 } },
  { label: "a started attempt", state: { startedAttempt: 1 } },
  {
    label: "an execution identity",
    state: {
      executionIdentity: {
        tokenVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "recovery-1",
        createdAt: 100,
      },
    },
  },
  {
    label: "a reservation",
    state: {
      reservation: { attempt: 1, lifecycleGeneration: "generation-1", runId: "recovery-1" },
    },
  },
  {
    label: "a foreground claim",
    state: { foregroundClaims: { lifecycleGeneration: "generation-1", tokens: ["foreground-1"] } },
  },
  { label: "a tombstone", state: { tombstone: { reason: "exhausted" } } },
  {
    label: "a recovery run",
    state: {},
    entry: { restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }] },
  },
  {
    label: "a pending delivery run",
    state: {},
    entry: { restartRecoveryDeliveryRunId: "delivery-1" },
  },
  {
    label: "a pending final delivery",
    state: {},
    entry: { pendingFinalDelivery: { kind: "replayable", text: "result", createdAt: 100 } },
  },
];

describe("empty main session recovery aggregate", () => {
  it("clears the last cancelled reservation after a foreground turn settles", () => {
    const session = entry({ abortedLastRun: true });
    const reserved = transitionMainSessionRecovery(session, {
      kind: "prepare_attempt",
      attempt: 1,
      executionIdentity: { state: "disabled" },
      lifecycleGeneration: "generation-1",
      now: 100,
      observation: { sessionId: session.sessionId, cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
    });
    if (reserved.kind !== "reserved") {
      throw new Error("expected recovery reservation");
    }
    expect(claimForeground(session, { runId: "foreground-run" }).kind).toBe("foreground_claimed");
    // Foreground preparation admits the turn without consuming the recovery reservation.
    session.abortedLastRun = false;
    const settled = projectMainSessionRecoveryLifecycle({
      currentLifecycleGeneration: "generation-1",
      entry: session,
      event: {
        runId: "foreground-run",
        lifecycleGeneration: "generation-1",
        data: { phase: "end" },
      },
      snapshotPatch: { status: "done", abortedLastRun: false },
    });
    if (settled.action !== "apply") {
      throw new Error("expected foreground settlement");
    }
    Object.assign(session, settled.patch);
    expect(session.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expect(session.restartRecoveryRuns).toBeUndefined();
    expect(session.mainRestartRecovery?.reservation?.runId).toBe("recovery-1");

    expect(
      transitionMainSessionRecovery(session, {
        kind: "cancel_reservation",
        reservation: reserved.reservation,
      }),
    ).toEqual({ kind: "applied" });
    expect(session.mainRestartRecovery).toBeUndefined();
    expect(session.restartRecoveryTerminalRunIds).toContain("foreground-run");
  });

  it("keeps an interrupted cycle recoverable after cancelling its first reservation", () => {
    const reservation = { attempt: 1, lifecycleGeneration: "generation-1", runId: "recovery-1" };
    const session = entry({
      abortedLastRun: true,
      mainRestartRecovery: recoveryState({ chargedAttempts: 1, reservation }),
    });
    expect(
      transitionMainSessionRecovery(session, {
        kind: "cancel_reservation",
        reservation: { ...reservation, sessionId: session.sessionId, cycleId: "cycle-1" },
      }),
    ).toEqual({ kind: "applied" });
    expect(session.mainRestartRecovery).toMatchObject({ chargedAttempts: 0 });
    expect(session.mainRestartRecovery?.reservation).toBeUndefined();
    expect(session.abortedLastRun).toBe(true);
  });

  it.each([false, true])("reconciles existing empty residue (interrupted=%s)", (interrupted) => {
    const session = entry({ abortedLastRun: interrupted });
    expect(
      transitionMainSessionRecovery(session, {
        kind: "observe",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionKey,
      }),
    ).toMatchObject({
      kind: "observed",
      view: { status: interrupted ? "recoverable" : "inactive" },
    });
    expect(Boolean(session.mainRestartRecovery)).toBe(interrupted);
    expect(session.abortedLastRun).toBe(interrupted);
  });

  it("clears an uncharged empty aggregate before healthy foreground admission", () => {
    const session = entry({ restartRecoveryRuns: undefined });

    expect(claimForeground(session)).toEqual({ kind: "applied" });
    expect(session.mainRestartRecovery).toBeUndefined();
    expect(session.restartRecoveryRuns).toBeUndefined();
  });

  it("preserves interrupted recovery custody for foreground admission", () => {
    const session = entry({
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: undefined,
    });

    expect(claimForeground(session)).toMatchObject({ kind: "foreground_claimed" });
    expect(session).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        chargedAttempts: 0,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1"],
        },
      },
    });
    expect(session.restartRecoveryRuns).toBeUndefined();
  });

  it("preserves an empty aggregate when the foreground claim names another session", () => {
    const session = entry({ restartRecoveryRuns: undefined });
    const before = structuredClone(session);

    expect(claimForeground(session, { sessionId: "replacement-session" })).toEqual({
      kind: "no_change",
    });
    expect(session).toEqual(before);
  });

  it("preserves an empty aggregate on a non-candidate session", () => {
    const session = entry({ restartRecoveryRuns: undefined, spawnDepth: 1 });
    const before = structuredClone(session);

    expect(claimForeground(session)).toEqual({ kind: "no_change" });
    expect(session).toEqual(before);
  });

  it.each(ownershipControls)(
    "preserves an empty aggregate while $label remains",
    ({ state, entry: overrides }) => {
      const session = entry({
        mainRestartRecovery: recoveryState(state),
        restartRecoveryRuns: undefined,
        ...overrides,
      });
      const before = structuredClone(session);

      expect(claimForeground(session)).toEqual({ kind: "no_change" });
      expect(session).toEqual(before);
    },
  );
});
