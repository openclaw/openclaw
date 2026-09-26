/** Regression coverage for ACP background-task summary truncation boundaries. */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.test-support.js";
import { captureTaskDeliveryWork } from "../../tasks/task-registry-delivery.test-support.js";
import { findTaskByRunId, getTaskById, listTaskRecords } from "../../tasks/task-registry.js";
import { bindTaskRunExecution } from "../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import {
  appendBackgroundTaskProgressSummary,
  bindBackgroundTaskExecution,
  createBackgroundTaskRecord,
  markBackgroundTaskRunning,
  markBackgroundTaskTerminal,
  resolveBackgroundTaskContext,
  resolveBackgroundTaskFailureStatus,
} from "./manager.background-task.js";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "./manager.turn-timeout.js";
import { DEFAULT_DEPS, type AcpSessionManagerDeps } from "./manager.types.js";

// U+1F99E (🦞) is a surrogate pair in UTF-16; a raw .slice() boundary can split it.
const LOBSTER = "🦞";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetDetachedTaskLifecycleRuntimeForTests();
});

const HIGH_SURROGATE_WITHOUT_LOW = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

function fakeDeps(storePath: string): AcpSessionManagerDeps {
  return {
    ...DEFAULT_DEPS,
    loadSessionEntryAsync: async (params) => ({
      cfg: params.cfg ?? {},
      agentId: params.agentId,
      storePath,
      sessionKey: params.sessionKey,
      storeSessionKey: params.sessionKey,
      entry: {
        sessionId: params.sessionKey,
        updatedAt: 0,
        ...(params.sessionKey === "child-session" ? { spawnedBy: "agent:main:main" } : {}),
      },
    }),
  };
}

describe("appendBackgroundTaskProgressSummary", () => {
  it("keeps surrogate pairs intact at the progress truncation boundary", () => {
    // combined length 244 puts the pair astride the 239-char cut point.
    const result = appendBackgroundTaskProgressSummary("x".repeat(238), `${LOBSTER}tail`);
    expect(result).toBe(`${"x".repeat(238)}…`);
    expect(HIGH_SURROGATE_WITHOUT_LOW.test(result)).toBe(false);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it("still truncates plain ASCII exactly at the boundary", () => {
    const result = appendBackgroundTaskProgressSummary("a".repeat(240), "b");
    expect(result).toBe(`${"a".repeat(239)}…`);
  });

  it("returns short combined summaries unchanged", () => {
    expect(appendBackgroundTaskProgressSummary("done: ", "ok")).toBe("done: ok");
    expect(appendBackgroundTaskProgressSummary("", `  step ${LOBSTER}`)).toBe(`step ${LOBSTER}`);
  });
});

describe("resolveBackgroundTaskContext", () => {
  it("keeps surrogate pairs intact in the bounded task label", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      // normalized length 164 puts the pair astride the 159-char cut point.
      const context = await resolveBackgroundTaskContext({
        deps: fakeDeps(state.statePath("sessions.json")),
        assertCurrent: () => {},
        cfg: {},
        sessionKey: "child-session",
        agentId: "qa",
        requestId: "run-1",
        text: `${"y".repeat(158)}${LOBSTER}tail`,
      });
      expect(context?.task).toBe(`${"y".repeat(158)}…`);
      expect(HIGH_SURROGATE_WITHOUT_LOW.test(context?.task ?? "")).toBe(false);
    });
  });

  it("passes short task text through unchanged", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const context = await resolveBackgroundTaskContext({
        deps: fakeDeps(state.statePath("sessions.json")),
        assertCurrent: () => {},
        cfg: {},
        sessionKey: "child-session",
        agentId: "qa",
        requestId: "run-2",
        text: `summarize ${LOBSTER} feedback`,
      });
      expect(context?.task).toBe(`summarize ${LOBSTER} feedback`);
    });
  });
});

describe("resolveBackgroundTaskFailureStatus", () => {
  it("uses the structured timeout detail instead of message text", () => {
    expect(
      resolveBackgroundTaskFailureStatus(
        new AcpRuntimeError("ACP_TURN_FAILED", "turn deadline reached", {
          detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE,
        }),
      ),
    ).toBe("timed_out");
    expect(
      resolveBackgroundTaskFailureStatus(
        new AcpRuntimeError("ACP_TURN_FAILED", "backend said the request timed out"),
      ),
    ).toBe("failed");
  });
});

describe("ACP background task execution binding", () => {
  it("keeps distinct execution tasks and routes late same-instance mirrors to the original task", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      using deliveries = captureTaskDeliveryWork();
      const runtime = getDetachedTaskLifecycleRuntime();
      const start = vi.fn(runtime.startTaskRunByRunId);
      const fail = vi.fn(runtime.failTaskRunByRunId);
      const complete = vi.fn(runtime.completeTaskRunByRunId);
      setDetachedTaskLifecycleRuntime({
        ...runtime,
        startTaskRunByRunId: start,
        failTaskRunByRunId: fail,
        completeTaskRunByRunId: complete,
      });
      const context = {
        agentId: "qa",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:qa:child",
        runId: "run-reused-acp",
        task: "Identical request text",
      };
      const first = createBackgroundTaskRecord(context, 100, "instance-first");
      if (!first) {
        throw new Error("Expected the first ACP task");
      }
      markBackgroundTaskTerminal(first, { status: "cancelled", endedAt: 200 });
      const original = getTaskById(first.taskId);
      const second = createBackgroundTaskRecord(context, 300, "instance-second");
      if (!second) {
        throw new Error("Expected the second ACP task");
      }
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.parentFlowId).not.toBe(first.parentFlowId);
      expect(getTaskById(second.taskId)).toMatchObject({
        status: "running",
        task: context.task,
        detail: { instanceId: "instance-second", generation: 2 },
      });
      expect(findTaskByRunId(context.runId)?.taskId).toBe(second.taskId);
      expect(createBackgroundTaskRecord(context, 400, "instance-first")).toEqual(first);
      expect(getTaskById(first.taskId)).toEqual(original);
      expect(getTaskById(first.taskId)?.detail).toMatchObject({ generation: 1 });
      markBackgroundTaskRunning(first, { progressSummary: "late predecessor output" });
      markBackgroundTaskRunning(second, { progressSummary: "current output" });
      markBackgroundTaskTerminal(second, { status: "succeeded", endedAt: 500 });
      expect(getTaskById(first.taskId)).toEqual(original);
      expect(getTaskById(second.taskId)).toMatchObject({
        status: "succeeded",
        progressSummary: "current output",
      });
      expect(listTaskRecords().filter((task) => task.runId === context.runId)).toHaveLength(2);
      expect(start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          taskId: second.taskId,
          runId: context.runId,
          runtime: "acp",
          sessionKey: context.childSessionKey,
        }),
      );
      expect(fail).toHaveBeenCalledWith(expect.objectContaining({ taskId: first.taskId }));
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ taskId: second.taskId }));

      const otherScope = createBackgroundTaskRecord(
        {
          ...context,
          agentId: "other",
          childSessionKey: "agent:other:child",
        },
        600,
        "instance-other",
      );
      expect(otherScope).toBeDefined();
      expect(findTaskByRunId(context.runId)?.taskId).toBe(second.taskId);
      const otherRun = createBackgroundTaskRecord(
        { ...context, runId: "run-later-acp" },
        700,
        "instance-later",
      );
      expect(findTaskByRunId("run-later-acp")?.taskId).toBe(otherRun?.taskId);
      expect(findTaskByRunId(context.runId)?.taskId).toBe(second.taskId);
      expect(getTaskById(first.taskId)).toEqual(original);
      await deliveries.settle();
    });
  });

  it.each([false, true])(
    "binds the exact admitted execution at prompt submission (state directory changes: %s)",
    async (changeStateDir) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-acp-execution-binding-" },
        async (state) => {
          resetTaskRegistryForTests();
          resetTaskFlowRegistryForTests();
          const admitted: AdmittedRunContext = {
            operationalRunInstance: { instanceId: "instance-acp", runId: "run-acp" },
            executionIdentityToken: createExecutionIdentityAdmissionToken("run-acp", {
              contextId: "context-acp",
              executionId: "execution-acp",
            }),
          };
          const record = createBackgroundTaskRecord(
            {
              agentId: "qa",
              requesterAgentId: "main",
              requesterSessionKey: "agent:main:main",
              childSessionKey: "agent:qa:child",
              runId: "run-acp",
              task: "private",
            },
            100,
            admitted.operationalRunInstance.instanceId,
          );
          const task = findTaskByRunId("run-acp");
          if (!record || !task?.parentFlowId) {
            throw new Error("expected ACP task and owner flow");
          }
          const db = openOpenClawStateDatabase().db;
          expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);

          const binding = bindBackgroundTaskExecution(record, admitted);
          if (changeStateDir) {
            process.env.OPENCLAW_STATE_DIR = path.join(state.stateDir, "replacement");
          }
          try {
            await binding;
          } finally {
            process.env.OPENCLAW_STATE_DIR = state.stateDir;
          }

          expect(
            db
              .prepare(
                `SELECT owner_kind, owner_id, context_id, execution_id
               FROM execution_owner_lifecycle_bindings
               ORDER BY owner_kind`,
              )
              .all(),
          ).toEqual([
            {
              owner_kind: "flow",
              owner_id: task.parentFlowId,
              context_id: "context-acp",
              execution_id: "execution-acp",
            },
            {
              owner_kind: "task",
              owner_id: task.taskId,
              context_id: "context-acp",
              execution_id: "execution-acp",
            },
          ]);
        },
      );
    },
  );

  it.each(["missing", "mismatched"] as const)(
    "does not bind a live parent flow when the task owner is %s",
    async (taskOwnerState) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `openclaw-acp-${taskOwnerState}-task-binding-` },
        async () => {
          resetTaskRegistryForTests();
          resetTaskFlowRegistryForTests();
          const admitted: AdmittedRunContext = {
            operationalRunInstance: { instanceId: "instance-acp", runId: "run-acp" },
            executionIdentityToken: createExecutionIdentityAdmissionToken("run-acp", {
              contextId: "context-acp",
              executionId: "execution-acp",
            }),
          };
          const record = createBackgroundTaskRecord(
            {
              agentId: "qa",
              requesterAgentId: "main",
              requesterSessionKey: "agent:main:main",
              childSessionKey: "agent:qa:child",
              runId: "run-acp",
              task: "private",
            },
            100,
            admitted.operationalRunInstance.instanceId,
          );
          const task = findTaskByRunId("run-acp");
          if (!record || !task?.parentFlowId) {
            throw new Error("expected ACP task and owner flow");
          }
          const db = openOpenClawStateDatabase().db;
          if (taskOwnerState === "missing") {
            db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(task.taskId);
          } else {
            expect(
              await bindTaskRunExecution({
                taskId: task.taskId,
                admitted: {
                  operationalRunInstance: { instanceId: "instance-other", runId: "run-other" },
                  executionIdentityToken: createExecutionIdentityAdmissionToken("run-other", {
                    contextId: "context-other",
                    executionId: "execution-other",
                  }),
                },
              }),
            ).toBe("bound");
          }

          await bindBackgroundTaskExecution(record, admitted);

          if (taskOwnerState === "missing") {
            expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);
          } else {
            expect(
              db
                .prepare(
                  `SELECT context_id, execution_id
                   FROM execution_owner_lifecycle_bindings
                   WHERE owner_kind = 'flow' AND owner_id = ?`,
                )
                .get(task.parentFlowId),
            ).toBeUndefined();
          }
        },
      );
    },
  );
});
