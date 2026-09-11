import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { consumeSessionWorkAdmissionHandoff } from "../../../sessions/session-lifecycle-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { updateTask } from "../../../tasks/task-registry-mutation.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
} from "../../../tasks/task-registry.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { releaseSubagentRun } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture();
const SOURCE_CHANGED = "subagent restart recovery source changed before dispatch";
const ADMISSION_REACHED = "test reached the current admission boundary";

type SourceState = {
  source: SubagentRunRecord;
  task: TaskRecord | undefined;
  registerSuccessor: () => void;
};

async function checkPendingRecovery(
  mutate: (state: SourceState) => void | Promise<void>,
  options: {
    policy?: "core_required" | "custom" | "gateway_best_effort";
    allowed?: boolean;
  } = {},
) {
  if (options.policy === "custom") {
    setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });
  }
  const sessionKey = "agent:main:subagent:pending-recovery-authority";
  const sessionId = "pending-recovery-session";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
    abortedLastRun: true,
  });
  const registration = {
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "original recovery task",
    cleanup: "keep" as const,
    expectsCompletionMessage: false,
    taskRowOwnership:
      options.policy === "gateway_best_effort"
        ? ("gateway_best_effort" as const)
        : ("required" as const),
  };
  registerSubagentRun({ ...registration, runId: "source" });
  const source = subagentRuns.get("source")!;
  const entered = createDeferred();
  const resume = createDeferred();
  const admitted = vi.fn();
  let assertCurrent: (() => void) | undefined;
  const dispatchAgent: GatewayRecoveryRuntime["dispatchAgent"] = async (
    payload,
    _timeoutMs,
    dispatchOptions,
  ) => {
    const admission = consumeSessionWorkAdmissionHandoff({
      handoffId: payload.internalRuntimeHandoffId!,
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    expect(admission).toBeDefined();
    try {
      assertCurrent = dispatchOptions?.assertAdmissionCurrent;
      if (!assertCurrent) {
        throw new Error("recovery did not carry its source authority");
      }
      assertCurrent();
      entered.resolve();
      await resume.promise;
      assertCurrent();
      admitted();
      // This owner test stops before acceptance; the Gateway E2E covers the transfer.
      throw new Error(ADMISSION_REACHED);
    } finally {
      admission?.release();
    }
  };
  const pending = recoverInterruptedSubagentRow({
    runId: source.runId,
    entry: source,
    now: Date.now(),
    gatewayRuntime: {
      dispatchAgent,
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
    },
    isCurrent: (runId, entry) =>
      subagentRuns.get(runId) === entry &&
      getLatestSubagentRunByChildSessionKeyFromRuns(
        getSubagentRunsForChildSession(entry.childSessionKey),
        entry.childSessionKey,
      ) === entry,
    getRun: (runId) => subagentRuns.get(runId),
    reserveLaunch: ({ idempotencyKey }) => idempotencyKey,
    markLaunchAttempted: (params) => ({ ...params, sessionId, phase: "attempted" }),
    markLaunchConsumed: (params) => ({ ...params, sessionId, phase: "consumed" }),
    markLaunchAccepted: vi.fn(),
    resetLaunchAttempt: () => true,
    abandonLaunch: () => true,
    clearAcceptedRecovery: () => true,
    clearPendingNotice: () => true,
    resumeAcceptedRecovery: () => true,
    replaceRun: () => false,
    warn: vi.fn(),
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then((result) => {
        throw new Error(`Recovery ended before admission: ${JSON.stringify(result)}`);
      }),
    ]);
    await mutate({
      source,
      task: findTaskByRunId(source.taskRunId ?? source.runId),
      registerSuccessor: () =>
        registerSubagentRun({ ...registration, runId: "successor", task: "new owner task" }),
    });
  } finally {
    resume.resolve();
    await pending;
  }
  expect(await pending).toEqual({
    status: "retry",
    error: options.allowed ? ADMISSION_REACHED : SOURCE_CHANGED,
  });
  expect(admitted).toHaveBeenCalledTimes(options.allowed ? 1 : 0);
  expect(assertCurrent).toBeDefined();
  expect(() => assertCurrent!()).toThrow(SOURCE_CHANGED);
}

it.each(["retained", "completed", "removed"] as const)(
  "permanently revokes pending recovery after a committed successor is %s",
  async (state) => {
    await checkPendingRecovery(({ source, registerSuccessor }) => {
      registerSuccessor();
      const successor = subagentRuns.get("successor")!;
      expect(loadSubagentRegistryFromSqlite().has(successor.runId)).toBe(true);
      if (state === "completed") {
        successor.execution = {
          ...successor.execution,
          status: "terminal",
          endedAt: Date.now(),
          outcome: { status: "ok" },
        };
        persistSubagentRunsToDiskOrThrow(subagentRuns, [successor.runId]);
      } else if (state === "removed") {
        releaseSubagentRun(successor.runId);
        expect(subagentRuns.has(successor.runId)).toBe(false);
        expect(
          getLatestSubagentRunByChildSessionKeyFromRuns(
            getSubagentRunsForChildSession(source.childSessionKey),
            source.childSessionKey,
          ),
        ).toBe(source);
      }
    });
  },
);

it.each(["registration", "replacement"] as const)(
  "keeps source authority after a failed %s rolls back",
  async (operation) => {
    await checkPendingRecovery(
      ({ source, registerSuccessor }) => {
        const database = openOpenClawStateDatabase().db;
        const before = loadSubagentRegistryFromSqlite();
        database.exec(`CREATE TEMP TRIGGER reject_pending_recovery_successor
          BEFORE INSERT ON subagent_runs WHEN NEW.run_id = 'successor'
          BEGIN SELECT RAISE(ABORT, 'successor write rejected'); END`);
        try {
          if (operation === "registration") {
            expect(registerSuccessor).toThrow("successor write rejected");
          } else {
            expect(
              replaceSubagentRunAfterSteerCore({
                previousRunId: source.runId,
                nextRunId: "successor",
                expected: source,
                persistenceFailure: "return-false",
              }),
            ).toBe(false);
          }
          expect(subagentRuns.get(source.runId)).toBe(source);
          expect(subagentRuns.has("successor")).toBe(false);
          expect(loadSubagentRegistryFromSqlite()).toEqual(before);
        } finally {
          database.exec("DROP TRIGGER reject_pending_recovery_successor");
        }
      },
      { allowed: true },
    );
  },
);

it.each([
  "row",
  "generation",
  "createdAt",
  "child",
  "requester",
  "requester agent",
  "task run",
  "task text",
  "policy",
  "task backing",
  "task row",
] as const)("rejects a pending recovery whose original %s changes", async (field) => {
  await checkPendingRecovery(({ source, task }) => {
    if (field === "row") {
      subagentRuns.set(source.runId, structuredClone(source));
    } else if (field === "generation") {
      source.generation = source.generation! + 1;
    } else if (field === "createdAt") {
      source.createdAt += 1;
    } else if (field === "child") {
      source.childSessionKey = "agent:main:subagent:replacement-child";
    } else if (field === "requester") {
      source.requesterSessionKey = "agent:main:replacement-requester";
    } else if (field === "requester agent") {
      source.requesterAgentId = "replacement-agent";
    } else if (field === "task run") {
      source.taskRunId = "replacement-task-run";
    } else if (field === "task text") {
      source.task = "changed recovery instruction";
    } else if (field === "policy") {
      source.taskOwnershipPolicy = "gateway_best_effort";
    } else if (field === "task row") {
      expect(deleteTaskRecordById(task!.taskId)).toBe(true);
      const replacement = createTaskRecord({ ...task!, task: source.task });
      expect(replacement).not.toBeNull();
      expect(replacement!.taskId).not.toBe(task!.taskId);
    } else {
      expect(
        updateTask(task!.taskId, {
          detail: createSubagentTaskBackingDetail(source.generation! + 1),
        }),
      ).not.toBeNull();
    }
  });
});

it.each(["custom", "gateway_best_effort"] as const)(
  "preserves valid %s recovery ownership",
  async (policy) => {
    await checkPendingRecovery(() => {}, { policy, allowed: true });
  },
);

it("rejects custom recovery after its registered runtime disappears", async () => {
  await checkPendingRecovery(() => resetDetachedTaskLifecycleRuntimeForTests(), {
    policy: "custom",
  });
});

it("preserves failure-finalization backing when task progress becomes terminal", async () => {
  await checkPendingRecovery(
    ({ task }) => {
      expect(
        updateTask(task!.taskId, {
          status: "timed_out",
          progressSummary: "interrupted progress remains available",
        }),
      ).not.toBeNull();
    },
    { allowed: true },
  );
});
