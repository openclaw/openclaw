import { expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import {
  isMainSessionRecoveryPending,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";

it("keeps an external-effect hold through restart, late settlement and generic clear", () => {
  const entry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
  };
  const inspect = () =>
    transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "new-generation",
      sessionKey: "agent:main:main",
    });
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "pause",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      effect: {
        reason: "unverifiable-external-effect",
        toolCallId: "send-1",
        toolName: "message",
      },
    }),
  ).toEqual({ kind: "applied" });
  expect(inspect()).toMatchObject({ kind: "observed", view: { status: "blocked" } });
  expect(isMainSessionRecoveryPending(entry, "agent:main:main")).toBe(false);
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: "new-generation",
      sessionId: entry.sessionId,
      sessionKey: "agent:main:main",
      claimId: "foreground-1",
    }),
  ).toEqual({ kind: "rejected", reason: "session_paused" });
  expect(transitionMainSessionRecovery(entry, { kind: "clear" })).toEqual({
    kind: "rejected",
    reason: "session_paused",
  });
  expect(buildMainSessionRecoveryClearPatch(entry)).toEqual({});
  expect(
    projectMainSessionRecoveryLifecycle({
      entry,
      currentLifecycleGeneration: "new-generation",
      event: { runId: "old-run", lifecycleGeneration: "old-generation", data: { phase: "end" } },
      snapshotPatch: { status: "done", mainRestartRecovery: undefined },
    }),
  ).toMatchObject({ patch: { mainRestartRecovery: { pause: { toolCallId: "send-1" } } } });
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "acknowledge_pause",
      now: 300,
      observation: { sessionId: "other-session", cycleId: "cycle-1", revision: 2 },
    }),
  ).toEqual({ kind: "rejected", reason: "session_replaced" });
  expect(
    transitionMainSessionRecovery(entry, {
      kind: "acknowledge_pause",
      now: 300,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 2 },
    }),
  ).toEqual({ kind: "applied" });
  expect(inspect()).toMatchObject({
    kind: "observed",
    view: { status: "recoverable", nextAttempt: 1 },
  });
  transitionMainSessionRecovery(entry, { kind: "mark_interrupted", now: 400, cycleId: "unused" });
  expect(entry.mainRestartRecovery?.acknowledgedPause).toBeUndefined();
});

it.each(["recovery-hold", "manual"] as const)(
  "acknowledges the hold with goal pause origin %s at the same timestamp",
  (origin) => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective: "Synthetic recovery goal",
        status: "active",
        createdAt: 100,
        updatedAt: 100,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    };
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "pause",
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        effect: { reason: "unverifiable-external-effect", toolCallId: "send-1" },
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.goalPauseOrigin).toBe("recovery-hold");
    entry.goalPauseOrigin = origin;
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "acknowledge_pause",
        now: 300,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 2 },
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.mainRestartRecovery?.pause).toBeUndefined();
    expect(entry.mainRestartRecovery?.acknowledgedPause?.toolCallId).toBe("send-1");
    expect(entry.goal?.status).toBe(origin === "manual" ? "paused" : "active");
    expect(entry.goalPauseOrigin).toBe(origin === "manual" ? "manual" : undefined);
  },
);
