import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { useQueuedCollectorAcceptanceStorageFixture } from "./subagent-registry-run-launch.sqlite.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { createSubagentRegistryTestDeps } from "./subagent-registry.persistence.test-support.js";
import { readSubagentRun, saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

describe("subagent registration identity storage", () => {
  const { registerPreparedCollector } = useQueuedCollectorAcceptanceStorageFixture();

  it.each(["live", "cold"] as const)(
    "rejects a %s durable identity collision for a custom task runtime",
    (state) => {
      const defaultRuntime = getDetachedTaskLifecycleRuntime();
      setDetachedTaskLifecycleRuntime({
        ...defaultRuntime,
        createQueuedTaskRun: (params) => ({
          taskId: `custom:${params.runId}`,
          runtime: params.runtime,
          requesterSessionKey: params.requesterSessionKey ?? "",
          ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
          scopeKind: params.scopeKind ?? "session",
          childSessionKey: params.childSessionKey,
          runId: params.runId,
          task: params.task,
          status: "queued",
          deliveryStatus: params.deliveryStatus ?? "pending",
          notifyPolicy: params.notifyPolicy ?? "silent",
          createdAt: Date.now(),
        }),
      });
      const runId = `custom-${state}-identity-collision`;
      registerSubagentRun({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "original custom owner",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      });
      const persisted = readSubagentRun(openOpenClawStateDatabase(), runId);
      if (state === "cold") {
        resetSubagentRegistryForTests({ persist: false });
      }

      expect(() =>
        registerSubagentRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}:replacement`,
          requesterSessionKey: "agent:main:other",
          requesterDisplayKey: "other",
          task: "replacement custom owner",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
        }),
      ).toThrow("already owned");

      expect(readSubagentRun(openOpenClawStateDatabase(), runId)).toEqual(persisted);
      expect(findTaskByRunId(runId)).toBeUndefined();
    },
  );

  it("fails registration before tentative ownership when durable identity lookup fails", () => {
    const runId = "registration-identity-lookup-failure";
    const lookupError = new Error("durable identity lookup failed");
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      findPersistedSubagentRunIdentityClaim: () => {
        throw lookupError;
      },
    });

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "reject before registration mutation",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow(lookupError);

    expect(subagentRuns.has(runId)).toBe(false);
    expect(readSubagentRun(openOpenClawStateDatabase(), runId)).toBeNull();
    expect(findTaskByRunId(runId)).toBeUndefined();
  });

  it("revalidates a collision introduced after the persisted identity preflight", () => {
    const sourceRunId = "registration-race-source";
    const runId = "registration-race-target";
    registerPreparedCollector(sourceRunId);
    const database = openOpenClawStateDatabase();
    const insertCollision = vi.fn(() => {
      database.db
        .prepare(
          `INSERT INTO subagent_runs
            (run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json)
           SELECT ?, child_session_key, controller_session_key, requester_session_key, created_at, payload_json
           FROM subagent_runs WHERE run_id = ?`,
        )
        .run(runId, sourceRunId);
      return null;
    });
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      findPersistedSubagentRunIdentityClaim: insertCollision,
    });

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "lose the post-preflight identity race",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("already owned");

    expect(insertCollision).toHaveBeenCalledOnce();
    expect(subagentRuns.has(runId)).toBe(false);
    expect(readSubagentRun(database, runId)).not.toBeNull();
    expect(findTaskByRunId(runId)).toBeUndefined();
  });
});
