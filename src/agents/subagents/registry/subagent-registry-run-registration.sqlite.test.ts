import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { useQueuedCollectorAcceptanceStorageFixture } from "./subagent-registry-run-launch.sqlite.test-support.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { readSubagentRun } from "./subagent-registry.store.sqlite.js";

function createCustomQueuedTask(
  params: Parameters<ReturnType<typeof getDetachedTaskLifecycleRuntime>["createQueuedTaskRun"]>[0],
): TaskRecord {
  if (!params.runId) {
    throw new Error("custom task fixture requires a run id");
  }
  return {
    taskId: `custom-task:${params.runId}`,
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
    detail: params.detail,
  };
}

describe("subagent registration rollback storage", () => {
  useQueuedCollectorAcceptanceStorageFixture();

  it("preserves a nested cross-run successor when the older custom registration fails", () => {
    const olderRunId = "failed-reentrant-older";
    const runId = "failed-reentrant-predecessor";
    const successorRunId = "failed-reentrant-successor";
    const childSessionKey = "agent:main:subagent:failed-reentrant";
    registerSubagentRun({
      runId: olderRunId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "older killed generation",
      cleanup: "keep",
      queued: true,
      taskRowOwnership: "required",
    });
    const olderRun = subagentRuns.get(olderRunId);
    if (!olderRun) {
      throw new Error("expected older registered run");
    }
    olderRun.killReconciliation = { killedAt: Date.now() - 1 };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [olderRunId]);

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    let successorReceipt: ReturnType<typeof registerSubagentRun>;
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => {
        if (params.runId !== runId) {
          return createCustomQueuedTask(params);
        }
        successorReceipt = registerSubagentRun({
          runId: successorRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "nested successor",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
        });
        throw new Error("primary custom registration failure");
      },
    });

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "replace during custom registration",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("primary custom registration failure");

    expect(subagentRuns.has(runId)).toBe(false);
    expect(subagentRuns.get(successorRunId)).toMatchObject({
      runId: successorRunId,
      childSessionKey,
      generation: 3,
    });
    expect(olderRun.killReconciliation?.supersededAt).toBeTypeOf("number");
    expect(readSubagentRun(openOpenClawStateDatabase(), olderRunId)).toEqual(olderRun);
    expect(readSubagentRun(openOpenClawStateDatabase(), runId)).toBeNull();
    expect(readSubagentRun(openOpenClawStateDatabase(), successorRunId)).toEqual(
      subagentRuns.get(successorRunId),
    );
    expectDefined(successorReceipt, "successor receipt").assertDispatchCurrent();
  });

  it("keeps a committed successor authoritative when predecessor compensation fails", () => {
    const olderRunId = "failed-compensation-older";
    const runId = "failed-compensation-predecessor";
    const successorRunId = "failed-compensation-successor";
    const childSessionKey = "agent:main:subagent:failed-compensation";
    const database = openOpenClawStateDatabase();
    registerSubagentRun({
      runId: olderRunId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "older killed generation",
      cleanup: "keep",
      queued: true,
      taskRowOwnership: "required",
    });
    const olderRun = expectDefined(subagentRuns.get(olderRunId), "older registered run");
    olderRun.killReconciliation = { killedAt: Date.now() - 1 };
    persistSubagentRunsToDiskOrThrow(subagentRuns, [olderRunId]);

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    let successorReceipt: ReturnType<typeof registerSubagentRun>;
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => {
        if (params.runId !== runId) {
          return createCustomQueuedTask(params);
        }
        successorReceipt = registerSubagentRun({
          runId: successorRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "committed successor",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
        });
        database.db.exec(`
          CREATE TRIGGER fail_stale_predecessor_compensation
          BEFORE DELETE ON subagent_runs
          WHEN OLD.run_id = '${runId}'
          BEGIN
            SELECT RAISE(ABORT, 'injected stale predecessor compensation failure');
          END
        `);
        throw new Error("primary predecessor registration failure");
      },
    });

    try {
      expect(() =>
        registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "predecessor fails after successor commit",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
        }),
      ).toThrow(
        "primary predecessor registration failure; registry rollback also failed: Error: injected stale predecessor compensation failure",
      );
    } finally {
      database.db.exec("DROP TRIGGER IF EXISTS fail_stale_predecessor_compensation");
    }

    expect(subagentRuns.has(runId)).toBe(false);
    expect(readSubagentRun(database, runId)).toMatchObject({ runId, generation: 2 });
    expect(subagentRuns.get(successorRunId)).toMatchObject({
      runId: successorRunId,
      childSessionKey,
      generation: 3,
    });
    expect(readSubagentRun(database, successorRunId)).toEqual(subagentRuns.get(successorRunId));
    expect(olderRun.killReconciliation?.supersededAt).toBeTypeOf("number");
    expect(readSubagentRun(database, olderRunId)).toEqual(olderRun);
    expectDefined(successorReceipt, "successor receipt").assertDispatchCurrent();
  });

  it("restores the staged predecessor when nested successor persistence fails", () => {
    const runId = "nested-write-failure-predecessor";
    const successorRunId = "nested-write-failure-successor";
    const childSessionKey = "agent:main:subagent:nested-write-failure";
    const database = openOpenClawStateDatabase();
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    let stagedPredecessor: ReturnType<typeof subagentRuns.get>;
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => {
        if (params.runId !== runId) {
          return createCustomQueuedTask(params);
        }
        stagedPredecessor = subagentRuns.get(runId);
        database.db.exec(`
          CREATE TRIGGER fail_nested_successor_insert
          BEFORE INSERT ON subagent_runs
          WHEN NEW.run_id = '${successorRunId}'
          BEGIN
            SELECT RAISE(ABORT, 'injected nested successor failure');
          END
        `);
        try {
          registerSubagentRun({
            runId: successorRunId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "nested successor fails",
            cleanup: "keep",
            queued: true,
            taskRowOwnership: "required",
          });
        } finally {
          database.db.exec("DROP TRIGGER IF EXISTS fail_nested_successor_insert");
        }
        return createCustomQueuedTask(params);
      },
    });

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "outer registration also fails",
        cleanup: "keep",
        queued: true,
        taskRowOwnership: "required",
      }),
    ).toThrow("injected nested successor failure");

    expect(stagedPredecessor).toBeDefined();
    expect(subagentRuns.has(runId)).toBe(false);
    expect(subagentRuns.has(successorRunId)).toBe(false);
    expect(readSubagentRun(database, runId)).toBeNull();
    expect(readSubagentRun(database, successorRunId)).toBeNull();
  });

  it("retains the primary custom failure when registry rollback also fails", () => {
    const runId = "custom-registration-dual-failure";
    const database = openOpenClawStateDatabase();
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: () => {
        database.db.exec(`
          CREATE TRIGGER fail_custom_registration_rollback
          BEFORE DELETE ON subagent_runs
          WHEN OLD.run_id = '${runId}'
          BEGIN
            SELECT RAISE(ABORT, 'injected registration rollback failure');
          END
        `);
        throw new Error("primary custom registration failure");
      },
    });

    try {
      expect(() =>
        registerSubagentRun({
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "preserve both registration failures",
          cleanup: "keep",
          queued: true,
          taskRowOwnership: "required",
        }),
      ).toThrow("primary custom registration failure; registry rollback also failed");
    } finally {
      database.db.exec("DROP TRIGGER IF EXISTS fail_custom_registration_rollback");
    }

    expect(subagentRuns.get(runId)).toMatchObject({ runId, generation: 1 });
    expect(readSubagentRun(database, runId)).toEqual(subagentRuns.get(runId));
  });
});
