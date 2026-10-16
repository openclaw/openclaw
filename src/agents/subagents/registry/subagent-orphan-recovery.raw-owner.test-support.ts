import { existsSync } from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { prepareSubagentRecoveryFixture } from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  type useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

export async function restartRegistry(
  fixture: ReturnType<typeof useSubagentRestartRecoveryFixture>,
) {
  await resetSubagentRegistryForTests({ persist: false });
  rotateAgentEventLifecycleGeneration();
  await initSubagentRegistry();
  await fixture.activateGatewayRuntime();
  await fixture.settle();
}

function readSession(sessionKey: string, agentId = "main") {
  return loadExactSessionEntry({ agentId, sessionKey })?.entry;
}

export function registerMissingStorageRecoveryTests() {
  it.each(["durable", "incognito"] as const)(
    "classifies missing %s storage for recovery without creating its database",
    async (storage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const databasePath = (
          storage === "incognito"
            ? resolveIncognitoOpenClawAgentSqlitePath
            : resolveOpenClawAgentSqlitePath
        )({ agentId: "main", env: state.env });
        if (storage === "incognito") {
          onTestFinished(() =>
            memorySessionActorOwners.closeDatabase({ agentId: "main", path: databasePath }),
          );
        }
        const childSessionKey = `agent:main:subagent:${storage === "incognito" ? "incognito-" : ""}missing-store`;
        const entry = makeRunRecord({
          runId: "missing-store-run",
          childSessionKey,
          childSessionIdentity: { sessionId: "lost-session", lifecycleRevision: "lost-revision" },
          execution: { status: "interrupted", startedAt: Date.now() - 1_000 },
        });
        const warn = vi.fn();
        const recover = (candidate: SubagentRunRecord) =>
          recoverInterruptedSubagentRow({
            entry: candidate,
            runId: candidate.runId,
            gatewayRuntime: undefined,
            isCurrent: () => true,
            warn,
          });
        const expectAbsent = () => {
          expect(existsSync(databasePath)).toBe(false);
          expect(
            memorySessionActorOwners.read({ agentId: "main", path: databasePath }),
          ).toBeUndefined();
        };
        expectAbsent();
        const running = { ...entry, execution: { ...entry.execution, status: "running" as const } };
        expect(await recover(running)).toEqual({ status: "ignored" });
        // An absent incognito actor must not fall back to SQLite, including authority preparation.
        const sql = storage === "incognito" ? observeMainThreadSql() : undefined;
        onTestFinished(() => sql?.restore());
        const result = await recover(entry);
        expect(result).toMatchObject({ status: "terminal", suppressSessionEffects: true });
        if (result.status !== "terminal") {
          throw new Error("Expected missing child storage to permit terminal settlement");
        }
        expect(await result.recoveryCurrent?.prepare()).toBe(true);
        expect(result.recoveryCurrent?.isHostCurrent()).toBe(true);
        if (sql) {
          expect(await result.sessionEffects?.isCurrent()).toBe(true);
          sql.expectIdle();
          sql.restore();
        }
        expect(warn).not.toHaveBeenCalled();
        expect(
          await recover({
            ...running,
            execution: {
              ...running.execution,
              restartRecovery: {
                phase: "accepted",
                sessionId: "lost-session",
                sessionMarker: "lost-session:1",
                idempotencyKey: "lost-recovery",
              },
            },
          }),
        ).toMatchObject({ status: "terminal", suppressSessionEffects: true });
        expectAbsent();

        await replaceSessionEntry(
          { agentId: "main", sessionKey: childSessionKey },
          {
            sessionId: "successor-session",
            lifecycleRevision: "successor-lifecycle",
            updatedAt: Date.now(),
          },
        );
        if (storage === "durable") {
          expect(result.recoveryCurrent?.isHostCurrent()).toBe(false);
          expect(await result.recoveryCurrent?.prepare()).toBe(false);
          expect(await result.sessionEffects?.isCurrent()).toBe(false);
        }
        const missingRow = await recover({ ...entry, childSessionKey: `${childSessionKey}-other` });
        expect(missingRow.status).toBe("terminal");
        if (missingRow.status === "terminal") {
          expect(missingRow.suppressSessionEffects).not.toBe(true);
        }
      });
    },
  );
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
    const mainBefore = readSession(childSessionKey);
    expect(mainBefore).toMatchObject({
      sessionId: "main-restore-session",
      status: "interrupted",
      abortedLastRun: true,
    });
    const recovered = makeRunRecord({
      runId,
      childSessionKey,
      childAgentId: "research",
      childSessionIdentity: {
        sessionId: "research-restore-session",
        lifecycleRevision: "research-restore-revision",
      },
      createdAt: startedAt,
      expectsCompletionMessage: true,
      endedReason: "subagent-complete",
      execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
      completion: { required: true, resultText: "Research result", capturedAt: endedAt },
      delivery: { status: "pending" },
    });
    await prepareSubagentRecoveryFixture(recovered, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(recovered);
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
    expect(readSession(childSessionKey)).toEqual(mainBefore);
    expect(readSession(childSessionKey, "research")).toMatchObject({
      sessionId: "research-restore-session",
      status: "done",
      abortedLastRun: false,
    });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it.each(["idle", "done"] as const)(
    "settles a replaced child once when its parent is %s across restarts",
    async (parentStatus) => {
      const entry = makeRunRecord({
        runId: "replaced-child-run",
        childSessionIdentity: {
          sessionId: "original-child",
          lifecycleRevision: "original-revision",
        },
        requesterSessionKey: "agent:main:replacement-parent",
        requesterTurnRunId: "original-parent-run",
        expectsCompletionMessage: false,
        completionRequesterSessionId: "original-parent",
        completionRequesterLifecycleRevision: "parent-revision",
        execution: {
          status: "interrupted",
          interruptionReason: "gateway-restart",
          startedAt: Date.now() - 1_000,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: entry.requesterSessionKey },
        {
          sessionId: "original-parent",
          lifecycleRevision: "parent-revision",
          updatedAt: Date.now(),
          status: parentStatus === "done" ? "done" : undefined,
        },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: entry.childSessionKey },
        {
          sessionId: "replacement-child",
          lifecycleRevision: "replacement-revision",
          lifecycleRunId: "replacement-run",
          updatedAt: Date.now(),
          status: "done",
        },
      );
      const replacement = readSession(entry.childSessionKey);
      await addSubagentRunForTests(entry);
      await fixture.settle();
      await restartRegistry(fixture);
      await testing.sweepOnceForTests();
      const settled = loadSubagentRegistryFromSqlite().get(entry.runId);
      expect(settled).toMatchObject({
        execution: {
          status: "terminal",
          suppressSessionEffects: true,
          outcome: {
            status: "error",
            error: expect.stringContaining("original session incarnation changed"),
          },
        },
        completionTarget: "parent",
      });
      expect(settled?.requesterTurnRunId).toBeUndefined();
      expect(readSession(entry.childSessionKey)).toEqual(replacement);
      const endedAt = settled?.execution.endedAt;
      await restartRegistry(fixture);
      expect(loadSubagentRegistryFromSqlite().get(entry.runId)?.execution.endedAt).toBe(endedAt);
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );
}
