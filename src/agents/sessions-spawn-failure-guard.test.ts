import { describe, expect, it } from "vitest";
import {
  buildSessionsSpawnFailureBudgetKey,
  buildSessionsSpawnFailureGuardKey,
  peekSessionsSpawnFailureBudget,
  peekSessionsSpawnFailureGuard,
  recordSessionsSpawnFailureBudget,
  recordSessionsSpawnFailureGuard,
  resetSessionsSpawnFailureGuardForTests,
  SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MAX_MS,
  SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MS,
  SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT,
  SESSIONS_SPAWN_FAILURE_BUDGET_WINDOW_MS,
  SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS,
  SESSIONS_SPAWN_FAILURE_GUARD_TTL_MAX_MS,
} from "./sessions-spawn-failure-guard.js";

const REQUESTER_KEY = "agent:test-requester:main";
const TARGET_ID = "test-target";

describe("sessions_spawn failure guard", () => {
  it("records and expires unrecoverable failures by requester+target", () => {
    resetSessionsSpawnFailureGuardForTests();
    const nowMs = 1000;
    const guardKey = buildSessionsSpawnFailureGuardKey({
      requesterInternalKey: REQUESTER_KEY,
      targetAgentId: TARGET_ID,
    });

    recordSessionsSpawnFailureGuard({
      guardKey,
      code: "missing_workspace",
      status: "error",
      error: `agentId "${TARGET_ID}" is not workspace-backed for sessions_spawn.`,
      nowMs,
    });

    expect(peekSessionsSpawnFailureGuard({ guardKey, nowMs })).toMatchObject({
      code: "missing_workspace",
      status: "error",
    });
    expect(
      peekSessionsSpawnFailureGuard({
        guardKey,
        nowMs: nowMs + SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS + 1,
      }),
    ).toBeUndefined();
  });

  it("escalates target-specific cooldown from base to 2x then max", () => {
    resetSessionsSpawnFailureGuardForTests();
    const guardKey = buildSessionsSpawnFailureGuardKey({
      requesterInternalKey: REQUESTER_KEY,
      targetAgentId: TARGET_ID,
    });

    const first = recordSessionsSpawnFailureGuard({
      guardKey,
      code: "missing_workspace",
      status: "error",
      error: `agentId "${TARGET_ID}" is not workspace-backed for sessions_spawn.`,
      nowMs: 10_000,
    });
    expect(first.ttlMs).toBe(SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS);

    const second = recordSessionsSpawnFailureGuard({
      guardKey,
      code: "missing_workspace",
      status: "error",
      error: first.error,
      nowMs: 12_000,
    });
    expect(second.ttlMs).toBe(SESSIONS_SPAWN_FAILURE_GUARD_TTL_MS * 2);

    const third = recordSessionsSpawnFailureGuard({
      guardKey,
      code: "missing_workspace",
      status: "error",
      error: first.error,
      nowMs: 14_000,
    });
    expect(third.ttlMs).toBe(SESSIONS_SPAWN_FAILURE_GUARD_TTL_MAX_MS);
  });

  it("blocks a requester after repeated failures across targets", () => {
    resetSessionsSpawnFailureGuardForTests();
    const budgetKey = buildSessionsSpawnFailureBudgetKey({
      requesterInternalKey: REQUESTER_KEY,
    });
    const baseNow = 20_000;

    for (let idx = 0; idx < SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT - 1; idx += 1) {
      const state = recordSessionsSpawnFailureBudget({
        budgetKey,
        nowMs: baseNow + idx * 100,
      });
      expect(state.retryAfterMs).toBeUndefined();
    }

    const blockedState = recordSessionsSpawnFailureBudget({
      budgetKey,
      nowMs: baseNow + SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT * 100,
    });
    expect(typeof blockedState.retryAfterMs).toBe("number");
    expect((blockedState.retryAfterMs ?? 0) > 0).toBe(true);

    const hit = peekSessionsSpawnFailureBudget({
      budgetKey,
      nowMs: baseNow + SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT * 100 + 1,
    });
    expect(hit).toBeDefined();
    expect((hit?.retryAfterMs ?? 0) > 0).toBe(true);

    expect(
      peekSessionsSpawnFailureBudget({
        budgetKey,
        nowMs:
          baseNow +
          SESSIONS_SPAWN_FAILURE_BUDGET_WINDOW_MS +
          SESSIONS_SPAWN_FAILURE_GUARD_TTL_MAX_MS +
          5_000,
      }),
    ).toBeUndefined();
  });

  it("escalates global budget block TTL from base to 2x then max", () => {
    resetSessionsSpawnFailureGuardForTests();
    const budgetKey = buildSessionsSpawnFailureBudgetKey({
      requesterInternalKey: REQUESTER_KEY,
    });
    const baseNow = 50_000;

    for (let idx = 0; idx < SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT - 1; idx += 1) {
      recordSessionsSpawnFailureBudget({
        budgetKey,
        nowMs: baseNow + idx,
      });
    }

    const firstBlock = recordSessionsSpawnFailureBudget({
      budgetKey,
      nowMs: baseNow + SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT,
    });
    expect(firstBlock.retryAfterMs).toBe(SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MS);

    const secondBlock = recordSessionsSpawnFailureBudget({
      budgetKey,
      nowMs: baseNow + SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT + 1,
    });
    expect(secondBlock.retryAfterMs).toBe(SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MS * 2);

    const thirdBlock = recordSessionsSpawnFailureBudget({
      budgetKey,
      nowMs: baseNow + SESSIONS_SPAWN_FAILURE_BUDGET_LIMIT + 2,
    });
    expect(thirdBlock.retryAfterMs).toBe(SESSIONS_SPAWN_FAILURE_BUDGET_BLOCK_TTL_MAX_MS);
  });
});
