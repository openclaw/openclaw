import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
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
    status: "done",
    abortedLastRun: false,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}
function claimForeground(
  session: SessionEntry,
  options: { sessionId?: string; sessionKey?: string } = {},
) {
  return transitionMainSessionRecovery(session, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: options.sessionId ?? "session-1",
    sessionKey: options.sessionKey ?? sessionKey,
    claimId: "foreground-1",
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
