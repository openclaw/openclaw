import { describe, expect, it } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { reloadTaskRegistryFromStore } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import {
  createCoreRequiredTaskBacking,
  makeRestartRecoveryRun,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

describe("released subagent ownership activation", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { activateGatewayRuntime, dispatchAgent } = fixture;

  async function hydrateCandidate(params: { runId: string; childSessionKey: string }) {
    const now = Date.now();
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: params.childSessionKey,
      sessionId: `session-${params.runId}`,
      updatedAt: now,
      abortedLastRun: true,
      defaultSessionId: `session-${params.runId}`,
    });
    const record = makeRestartRecoveryRun({
      runId: params.runId,
      taskRunId: params.runId,
      childSessionKey: params.childSessionKey,
      generation: 1,
      createdAt: now - 60_000,
      startedAt: now - 55_000,
    });
    record.taskOwnershipPolicy = "legacy_unresolved";
    record.legacyTaskOwnershipCandidate = "core_required";
    delete record.requesterAgentId;
    createCoreRequiredTaskBacking(record);
    addSubagentRunForTests(record);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [record.runId]);

    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    rotateAgentEventLifecycleGeneration();
    reloadTaskRegistryFromStore();
    initSubagentRegistry();
    expect(getSubagentRunByChildSessionKey(params.childSessionKey)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: "core_required",
    });
    expect(
      getSubagentRunByChildSessionKey(params.childSessionKey)?.requesterAgentId,
    ).toBeUndefined();
  }

  function readRawRunPayload(runId: string): string {
    const row = openOpenClawStateDatabase()
      .db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(runId) as { payload_json?: unknown } | undefined;
    if (typeof row?.payload_json !== "string") {
      throw new Error(`missing raw subagent payload for ${runId}`);
    }
    return row.payload_json;
  }

  it("adopts a complete default backing only after plugin activation", async () => {
    const runId = "released-default-activation";
    const childSessionKey = "agent:main:subagent:released-default-activation";
    await hydrateCandidate({ runId, childSessionKey });

    activateGatewayRuntime();

    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      taskOwnershipPolicy: "core_required",
    });
    expect(
      loadSubagentRegistryFromSqlite().get(runId)?.legacyTaskOwnershipCandidate,
    ).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterAgentId).toBe("main");
    const adoptedPayload = readRawRunPayload(runId);
    activateGatewayRuntime();
    expect(readRawRunPayload(runId)).toBe(adoptedPayload);
    await testing.sweepOnceForTests();
    expect(dispatchAgent).toHaveBeenCalledOnce();
  });

  it("keeps the candidate unresolved when a custom runtime registers after hydration", async () => {
    const runId = "released-custom-activation";
    const childSessionKey = "agent:main:subagent:released-custom-activation";
    await hydrateCandidate({ runId, childSessionKey });
    setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });

    try {
      activateGatewayRuntime();
      await testing.sweepOnceForTests();

      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        taskOwnershipPolicy: "legacy_unresolved",
        legacyTaskOwnershipCandidate: "core_required",
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterAgentId).toBeUndefined();
      expect(dispatchAgent).not.toHaveBeenCalled();
    } finally {
      resetDetachedTaskLifecycleRuntimeForTests();
    }
  });

  it.each(["deleted", "mutated", "duplicated", "foreign-detail", "competing-registry"] as const)(
    "keeps the candidate unresolved when its backing is %s after hydration",
    async (backingChange) => {
      const runId = `released-${backingChange}-activation`;
      const childSessionKey = `agent:main:subagent:released-${backingChange}-activation`;
      await hydrateCandidate({ runId, childSessionKey });
      const db = openOpenClawStateDatabase().db;
      if (backingChange === "deleted") {
        db.prepare("DELETE FROM task_runs WHERE run_id = ?").run(runId);
      } else if (backingChange === "mutated") {
        db.prepare(
          "UPDATE task_runs SET detail_json = json_set(detail_json, '$.generation', 2) WHERE run_id = ?",
        ).run(runId);
      } else if (backingChange === "duplicated") {
        db.prepare(`
          INSERT INTO task_runs (
            task_id, runtime, task_kind, source_id, requester_session_key, owner_key,
            scope_kind, child_session_key, parent_flow_id, parent_task_id, agent_id,
            requester_agent_id, run_id, label, task, status, delivery_status,
            notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after,
            error, progress_summary, terminal_summary, terminal_outcome, detail_json
          )
          SELECT task_id || '-duplicate', runtime, task_kind, source_id,
            requester_session_key, owner_key, scope_kind,
            child_session_key || ':foreign', parent_flow_id, parent_task_id, agent_id,
            requester_agent_id, run_id, label, task, status, delivery_status,
            notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after,
            error, progress_summary, terminal_summary, terminal_outcome, detail_json
          FROM task_runs WHERE run_id = ?
        `).run(runId);
      } else if (backingChange === "foreign-detail") {
        db.prepare(
          "UPDATE task_runs SET detail_json = json_set(detail_json, '$.taskId', 'foreign-task') WHERE run_id = ?",
        ).run(runId);
      } else {
        db.prepare(`
          INSERT INTO subagent_runs (
            run_id, child_session_key, controller_session_key,
            requester_session_key, created_at, payload_json
          )
          SELECT run_id || '-competitor', child_session_key || ':competitor',
            controller_session_key, requester_session_key, created_at + 1,
            json_set(
              payload_json,
              '$.runId', run_id || '-competitor',
              '$.childSessionKey', child_session_key || ':competitor',
              '$.taskRunId', ?
            )
          FROM subagent_runs WHERE run_id = ?
        `).run(runId, runId);
      }
      const rawPayload = readRawRunPayload(runId);

      activateGatewayRuntime();
      await testing.sweepOnceForTests();

      expect(readRawRunPayload(runId)).toBe(rawPayload);
      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        taskOwnershipPolicy: "legacy_unresolved",
        legacyTaskOwnershipCandidate: "core_required",
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)?.requesterAgentId).toBeUndefined();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("persists only owned hydration changes beside an unresolved row", () => {
    const unresolvedRunId = "released-mixed-unresolved";
    const unresolved = makeRestartRecoveryRun({
      runId: unresolvedRunId,
      childSessionKey: "agent:main:subagent:released-mixed-unresolved",
    });
    unresolved.taskOwnershipPolicy = "legacy_unresolved";
    unresolved.legacyTaskOwnershipCandidate = "core_required";
    delete unresolved.requesterAgentId;
    const owned = makeRestartRecoveryRun({
      runId: "released-mixed-owned",
      childSessionKey: "agent:main:subagent:released-mixed-owned",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    addSubagentRunForTests(unresolved);
    addSubagentRunForTests(owned);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [unresolved.runId, owned.runId]);
    const db = openOpenClawStateDatabase().db;
    const rawPayload = `${JSON.stringify(JSON.parse(readRawRunPayload(unresolvedRunId)), null, 2)}\n`;
    db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
      rawPayload,
      unresolvedRunId,
    );

    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    rotateAgentEventLifecycleGeneration();
    initSubagentRegistry();

    expect(readRawRunPayload(unresolvedRunId)).toBe(rawPayload);
    expect(loadSubagentRegistryFromSqlite().has(owned.runId)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().get(unresolvedRunId)).toMatchObject({
      taskOwnershipPolicy: "legacy_unresolved",
      legacyTaskOwnershipCandidate: "core_required",
    });
  });
});
