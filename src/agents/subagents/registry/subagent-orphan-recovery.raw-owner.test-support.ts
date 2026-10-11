import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  type useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

export function registerAbsentChildRestoreOwnershipTest() {
  it("settles a restarted absent child without reading or recreating storage", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      // Recovery runs after config admission; keep cold config bootstrap outside the SQL boundary.
      setRuntimeConfigSnapshot({});
      const childSessionKey = "agent:main:subagent:incognito-absent-restart";
      const entry = makeRunRecord({
        runId: "absent-actor-restart",
        childSessionKey,
        execution: { status: "interrupted", startedAt: 1 },
      });
      const warn = vi.fn();
      const sql = observeMainThreadSql();
      try {
        const result = await recoverInterruptedSubagentRow({
          entry,
          runId: entry.runId,
          gatewayRuntime: undefined,
          isCurrent: () => true,
          warn,
        });
        expect(result).toMatchObject({ status: "terminal", suppressSessionEffects: true });
        if (result.status !== "terminal") {
          throw new Error("Expected absent actor recovery to settle the interrupted run");
        }
        expect(await result.recoveryCurrent?.prepare()).toBe(true);
        expect(await result.sessionEffects?.isCurrent()).toBe(true);
        sql.expectIdle();
        expect(warn).not.toHaveBeenCalled();
        expect(
          memorySessionActorOwners.read({
            agentId: "main",
            path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          }),
        ).toBeUndefined();
      } finally {
        sql.restore();
      }
    });
  });
}

export function registerRawChildRestoreOwnershipTest(
  fixture: ReturnType<typeof useSubagentRestartRecoveryFixture>,
) {
  const { activateGatewayRuntime, dispatchAgent } = fixture;

  it("restores a completed raw-key child from its recorded agent instead of an aborted namesake", async () => {
    const childSessionKey = "global";
    const runId = "raw-owner-restore";
    const startedAt = Date.now() - 1_000;
    const endedAt = startedAt + 500;
    for (const agentId of ["main", "research"]) {
      await replaceSessionEntry(
        { agentId, sessionKey: childSessionKey },
        {
          sessionId: `${agentId}-restore-session`,
          lifecycleRevision: `${agentId}-restore-revision`,
          lifecycleRunId: agentId === "research" ? runId : "unrelated-main-run",
          status: agentId === "research" ? "done" : "interrupted",
          abortedLastRun: agentId === "main",
          startedAt,
          endedAt,
          updatedAt: endedAt,
        },
      );
    }
    const mainBefore = loadExactSessionEntry({
      agentId: "main",
      sessionKey: childSessionKey,
    })?.entry;
    expect(mainBefore).toMatchObject({
      sessionId: "main-restore-session",
      status: "interrupted",
      abortedLastRun: true,
    });
    await addSubagentRunForTests(
      makeRunRecord({
        runId,
        childSessionKey,
        childAgentId: "research",
        createdAt: startedAt,
        expectsCompletionMessage: true,
        endedReason: "subagent-complete",
        execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
        completion: { required: true, resultText: "Research result", capturedAt: endedAt },
        delivery: { status: "pending" },
      }),
    );
    await fixture.settle();
    await resetSubagentRegistryForTests({ persist: false });
    rotateAgentEventLifecycleGeneration();
    expect(subagentRuns.has(runId)).toBe(false);

    await initSubagentRegistry();
    await activateGatewayRuntime();
    await fixture.settle();

    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: runId, outcome: { status: "ok" } }),
    );
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      childAgentId: "research",
      cleanupCompletedAt: expect.any(Number),
      execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
      delivery: { status: "delivered" },
    });
    expect(loadExactSessionEntry({ agentId: "main", sessionKey: childSessionKey })?.entry).toEqual(
      mainBefore,
    );
    expect(
      loadExactSessionEntry({ agentId: "research", sessionKey: childSessionKey })?.entry,
    ).toMatchObject({
      sessionId: "research-restore-session",
      status: "done",
      abortedLastRun: false,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });
}
