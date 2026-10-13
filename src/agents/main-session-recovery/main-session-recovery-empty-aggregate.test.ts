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

  it("preserves an empty aggregate on a non-candidate session", () => {
    const session = entry({ restartRecoveryRuns: undefined, spawnDepth: 1 });
    const before = structuredClone(session);

    expect(claimForeground(session)).toEqual({ kind: "no_change" });
    expect(session).toEqual(before);
  });
});
