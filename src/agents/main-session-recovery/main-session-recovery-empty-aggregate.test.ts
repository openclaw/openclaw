import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";
import {
  recoveryEntry as entry,
  prepareRecoveryAttempt,
  observeRecovery,
  recoveryState,
} from "./main-session-recovery-state.test-support.js";

const sessionKey = "agent:main:main";
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

const reservation = { attempt: 1, lifecycleGeneration: "generation-1", runId: "recovery-1" };
const ownershipControls: [string, Partial<MainRestartRecoveryState>, Partial<SessionEntry>?][] = [
  ["a charged attempt", { chargedAttempts: 1 }],
  ["a started attempt", { startedAttempt: 1 }],
  [
    "an execution identity",
    {
      executionIdentity: {
        tokenVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "recovery-1",
        createdAt: 100,
      },
    },
  ],
  ["a reservation", { reservation }],
  [
    "a foreground claim",
    {
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    },
  ],
  ["a tombstone", { tombstone: { reason: "exhausted" } }],
  [
    "a recovery run",
    {},
    { restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }] },
  ],
  ["a pending delivery run", {}, { restartRecoveryDeliveryRunId: "delivery-1" }],
  [
    "a pending final delivery",
    {},
    {
      pendingFinalDelivery: { kind: "replayable", text: "result", createdAt: 100 },
    },
  ],
];

function expectUnchanged(
  session: SessionEntry,
  options: Parameters<typeof claimForeground>[1] = {},
) {
  const before = structuredClone(session);
  expect(claimForeground(session, options)).toEqual({ kind: "no_change" });
  expect(session).toEqual(before);
}

describe("empty main session recovery aggregate", () => {
  it("clears the last cancelled reservation after a foreground turn settles", () => {
    const session = entry({ abortedLastRun: true });
    const reserved = prepareRecoveryAttempt(session, { now: 100 });
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
    expect(observeRecovery(session).status).toBe(interrupted ? "recoverable" : "inactive");
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

  it.each([{ sessionId: "replacement-session" }, { sessionKey: "agent:main:cron:nightly" }])(
    "preserves an empty aggregate outside the foreground target: %j",
    (options) => {
      expectUnchanged(entry({ restartRecoveryRuns: undefined }), options);
    },
  );

  it.each(ownershipControls)(
    "preserves an empty aggregate while %s remains",
    (_label, state, overrides) => {
      expectUnchanged(
        entry({
          mainRestartRecovery: recoveryState(state),
          restartRecoveryRuns: undefined,
          ...overrides,
        }),
      );
    },
  );
});
