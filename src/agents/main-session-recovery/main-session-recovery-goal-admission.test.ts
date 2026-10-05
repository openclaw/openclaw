import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { admitAgentRestartRecovery } from "../../gateway/agent-turn/agent-run-recovery-admission.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { exerciseTrustedGoalStartup } from "./main-session-recovery-issuer-startup.test-support.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "./main-session-recovery-store.test-support.js";

afterEach(() => closeSkillsWatchers(true));

describe("captured goal native recovery admission", () => {
  const fixture = createMainSessionRecoveryStoreFixture();
  const sessionKey = "agent:main:main";
  let storePath: string;

  beforeEach(() => {
    storePath = fixture.fixtureStore();
  });
  afterEach(fixture.resetCase);

  it("reopens an uncharged durable capacity wait and fences its old epoch cleanup", async () => {
    const scope = { sessionKey, storePath };
    const generation = getAgentEventLifecycleGeneration();
    await replaceSessionEntry(scope, {
      sessionId: "waiting-session",
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "waiting-cycle", revision: 1, chargedAttempts: 0 },
    });
    await commitMainSessionRecovery({
      target: scope,
      command: {
        kind: "wait_capacity",
        now: 200,
        runId: "old-wait",
        lifecycleGeneration: generation,
        observation: { sessionId: "waiting-session", cycleId: "waiting-cycle", revision: 1 },
      },
    });
    await cleanupSessionStateForTest({ stateDir: path.dirname(storePath) });
    const reopened = loadSessionEntry(scope)!;
    expect(reopened.mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      capacityWait: { runId: "old-wait", lifecycleGeneration: generation, sinceMs: 200 },
    });
    expect(reopened.mainRestartRecovery?.reservation).toBeUndefined();
    rotateAgentEventLifecycleGeneration();
    const nextGeneration = getAgentEventLifecycleGeneration();
    await commitMainSessionRecovery({
      target: scope,
      command: {
        kind: "wait_capacity",
        now: 300,
        runId: "new-wait",
        lifecycleGeneration: nextGeneration,
        observation: {
          sessionId: "waiting-session",
          cycleId: "waiting-cycle",
          revision: reopened.mainRestartRecovery!.revision,
        },
      },
    });
    const cleanup = await commitMainSessionRecovery({
      target: scope,
      command: {
        kind: "cancel_capacity_wait",
        wait: {
          sessionId: "waiting-session",
          cycleId: "waiting-cycle",
          runId: "old-wait",
          lifecycleGeneration: generation,
        },
      },
    });
    expect(cleanup.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(loadSessionEntry(scope)?.mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      capacityWait: { runId: "new-wait", lifecycleGeneration: nextGeneration, sinceMs: 300 },
    });
  });

  it.each([
    "active",
    "terminal-error",
    "exhausted",
    "manual",
    "held",
    "cleared",
    "complete",
    "replaced",
    "goal-less pause",
    "goal-less complete",
  ] as const)("rechecks %s goal intent after reserving the native turn", async (change) => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const scope = { sessionKey, storePath };
    const entry: SessionEntry = {
      sessionId: "captured-session",
      lifecycleRevision: "captured-lifecycle",
      updatedAt: 100,
      status: "interrupted",
      abortedLastRun: true,
      goal: {
        schemaVersion: 1,
        id: "captured-goal",
        objective: "Finish the accepted work",
        status: "active",
        createdAt: 10,
        updatedAt: 100,
        tokenStart: 100,
        tokensUsed: 25,
        tokenBudget: 200,
        continuationTurns: 3,
      },
      restartRecoveryGoal: {
        id: "captured-goal",
        sessionId: "captured-session",
        lifecycleRevision: "captured-lifecycle",
        capturedAtMs: 100,
      },
      mainRestartRecovery: { cycleId: "captured-cycle", revision: 1, chargedAttempts: 0 },
    };
    await replaceSessionEntry(scope, entry);
    const reserved = await commitMainSessionRecovery({
      target: scope,
      command: {
        kind: "prepare_attempt",
        now: 200,
        attempt: 1,
        lifecycleGeneration,
        observation: { sessionId: entry.sessionId, cycleId: "captured-cycle", revision: 1 },
        runId: "captured-recovery",
        executionIdentity: { state: "disabled" },
      },
    });
    expect(reserved.transition.kind).toBe("reserved");
    const current = loadSessionEntry(scope)!;
    if (change === "cleared") {
      current.goal = undefined;
    } else if (change !== "active") {
      current.goal = {
        ...entry.goal!,
        status:
          change === "complete" || change === "goal-less complete"
            ? "complete"
            : change === "replaced"
              ? "active"
              : "paused",
        id: change === "replaced" ? "replacement-goal" : "captured-goal",
      };
      current.goalPauseOrigin =
        change === "manual" || change === "goal-less pause"
          ? "manual"
          : change === "terminal-error" || change === "exhausted"
            ? "terminal-error"
            : undefined;
    }
    if (change === "exhausted") {
      current.goal = { ...current.goal!, tokensUsed: 200, budgetLimitedAt: 77 };
    }
    if (change === "goal-less pause" || change === "goal-less complete") {
      current.restartRecoveryGoal = undefined;
    }
    if (change === "held") {
      current.mainRestartRecovery!.pause = {
        reason: "unverifiable-external-effect",
        pausedAtMs: 201,
        goalId: "captured-goal",
      };
      current.goalPauseOrigin = "recovery-hold";
    }
    await replaceSessionEntry(scope, current);
    const admission = admitAgentRestartRecovery({
      lifecycleGeneration,
      runId: "captured-recovery",
      sessionId: entry.sessionId,
      ...scope,
    });
    if (change === "active" || change === "terminal-error") {
      const admitted = await admission;
      expect(admitted.restoreInterrupted).toBeTypeOf("function");
      expect(admitted.entry.goal?.status).toBe("active");
      expect(admitted.entry.goalPauseOrigin).toBeUndefined();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: entry.sessionId,
        lifecycleRunId: "captured-recovery",
        abortedLastRun: false,
        goal: {
          id: "captured-goal",
          status: "active",
          tokenStart: 100,
          tokensUsed: 25,
          continuationTurns: 3,
        },
      });
    } else if (change === "exhausted") {
      await expect(admission).rejects.toThrow("goal budget is exhausted");
      expect(loadSessionEntry(scope)).toMatchObject({
        abortedLastRun: true,
        goal: {
          status: "budget_limited",
          tokenStart: 100,
          tokensUsed: 200,
          budgetLimitedAt: 77,
          continuationTurns: 3,
        },
        mainRestartRecovery: { chargedAttempts: 0 },
      });
      expect(loadSessionEntry(scope)?.mainRestartRecovery?.reservation).toBeUndefined();
    } else {
      await expect(admission).rejects.toThrow("reservation is stale");
      expect(loadSessionEntry(scope)).toEqual(current);
    }
  });
});

it("restores trusted goal intent through reopened SQLite and the startup facade under its original issuer", () =>
  exerciseTrustedGoalStartup());
it("restores the persisted Factory actor through startup and an entitled repository read", () =>
  exerciseTrustedGoalStartup(true));
it("continues a durably accepted no-goal turn once through restart and an entitled repository read", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  await exerciseTrustedGoalStartup(true, true);
});

it("preserves an accepted unmaterialized turn under an active Goal without borrowing another issuer", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  await exerciseTrustedGoalStartup(true, false, true);
});

it.each([true, "conflicting"] as const)(
  "restores committed original acceptance after terminal fence retirement without borrowing authority (source=%s)",
  async (source) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await exerciseTrustedGoalStartup(true, true, false, source);
  },
);
