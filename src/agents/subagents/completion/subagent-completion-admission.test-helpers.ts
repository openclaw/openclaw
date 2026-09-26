import { expect, vi } from "vitest";
import { prepareClaimedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { getTaskById } from "../../../tasks/runtime-internal.js";
import { prepareTaskRegistryRead } from "../../../tasks/task-registry-read.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../registry/subagent-registry-read.js";
import { saveSubagentRegistryToSqlite } from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  admitSubagentCompletionDelivery,
  settleSubagentCompletionDelivery,
} from "./subagent-completion-admission.store.js";

export function records() {
  const now = Date.now();
  const task: TaskRecord = {
    taskId: "task-completion",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:main:subagent:child",
    runId: "task-run",
    requesterAgentId: "main",
    task: "finish the work",
    status: "succeeded",
    deliveryStatus: "session_queued",
    terminalOutcome: "succeeded",
    notifyPolicy: "done_only",
    createdAt: now - 2_000,
    endedAt: now - 1_000,
    lastEventAt: now,
  };
  const subagent = createSubagentRunRecord({
    runId: "completion-run",
    taskRunId: task.runId,
    childSessionKey: task.childSessionKey,
    requesterSessionKey: task.requesterSessionKey,
    requesterDisplayKey: task.requesterSessionKey,
    requesterAgentId: "main",
    requesterOrigin: { channel: "discord", to: "channel:requester", accountId: "primary" },
    task: task.task,
    createdAt: task.createdAt,
    endedAt: task.endedAt,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "canonical result", capturedAt: now },
    delivery: {
      status: "in_progress",
      disposition: "session_queued",
      generation: 1,
      queueId: "placeholder",
      windowStartedAt: now,
      deadlineAt: now + 30 * 60_000,
    },
  });
  const queueEntry = prepareClaimedSessionDelivery(
    {
      kind: "agentTurn",
      sessionKey: task.requesterSessionKey,
      message: "canonical result is loaded at delivery time",
      messageId: "completion:1",
      idempotencyKey: "completion:1",
      owner: {
        kind: "subagent_completion",
        runId: subagent.runId,
        taskId: task.taskId,
        generation: 1,
        deadlineAt: subagent.delivery?.deadlineAt ?? 0,
      },
    },
    125_000,
    now,
  );
  subagent.delivery!.queueId = queueEntry.id;
  return { queueEntry, subagent, task };
}

export function requesterWakeDriver(inputs: ReturnType<typeof records>[]) {
  const wake = vi.fn<
    SubagentLifecycleController["options"]["maybeWakeRequesterAfterAllChildrenSettled"]
  >(async () => {
    throw new Error("requester unavailable");
  });
  const warn = vi.fn();
  const persist = () => saveSubagentRegistryToSqlite(subagentRuns);
  const controller = new SubagentLifecycleController({
    runs: subagentRuns,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    persist,
    persistOrThrow: persist,
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
    suppressAnnounceForSteerRestart: () => false,
    resolveSubagentTask: (entry) => ({
      lookup: "available",
      task: getTaskById(inputs.find((input) => input.subagent.runId === entry.runId)!.task.taskId),
    }),
    resolveSubagentTaskAsync: async (entry) => {
      const read = await prepareTaskRegistryRead();
      return read
        ? {
            lookup: "available",
            task: read.getTaskById(
              inputs.find((input) => input.subagent.runId === entry.runId)!.task.taskId,
            ),
          }
        : { lookup: "unavailable" };
    },
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: vi.fn(),
    captureSubagentCompletionReply: vi.fn(),
    runSubagentAnnounceFlow: vi.fn(),
    maybeWakeRequesterAfterAllChildrenSettled: wake,
    warn,
  });
  return {
    controller,
    wake,
    warn,
    async run(entry = inputs[0]!.subagent) {
      controller.resumeRequesterSettleWake(entry.runId, entry);
      await vi.waitFor(() => expect(wake).toHaveBeenCalled());
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    },
  };
}

export function armRequesterWake(
  input: ReturnType<typeof records>,
  batchRunIds = [input.subagent.runId],
) {
  input.subagent.cleanupHandled = true;
  input.subagent.cleanupCompletedAt = Date.now();
  input.subagent.requesterSettleWake = {
    status: "pending",
    attemptCount: 0,
    rearmGeneration: 1,
    batchRunIds,
  };
  return input;
}

export function failedRecords(
  status: Extract<TaskRecord["status"], "cancelled" | "failed" | "timed_out">,
  outcome: NonNullable<SubagentRunRecord["execution"]["outcome"]>,
) {
  const input = records();
  input.task.status = status;
  delete input.task.terminalOutcome;
  input.task.error = "original child failure";
  input.task.terminalSummary = "original failure summary";
  input.task.cleanupAfter = Date.now() + 5_000;
  input.subagent.endedReason = status === "cancelled" ? "subagent-killed" : "subagent-error";
  input.subagent.execution.outcome = outcome;
  return armRequesterWake(input);
}

export function expectLinkedGenerationTransaction({
  database,
  rowCount,
  clearRows,
}: {
  database: OpenClawStateDatabase;
  rowCount: (table: "delivery_queue_entries" | "subagent_runs" | "task_runs") => number;
  clearRows: () => void;
}): void {
  const input = records();
  const phases: string[] = [];
  const first = admitSubagentCompletionDelivery({
    ...input,
    databaseOptions: { database },
    testHooks: {
      afterMutation: (phase, exactDatabase) => {
        expect(exactDatabase).toBe(database);
        expect(exactDatabase.db.isTransaction).toBe(true);
        phases.push(phase);
      },
    },
  });
  expect(first).toMatchObject({ claimed: true, status: "pending" });
  expect(phases).toEqual(["queue", "subagent", "task"]);
  expect(rowCount("delivery_queue_entries")).toBe(1);
  expect(rowCount("subagent_runs")).toBe(1);
  expect(rowCount("task_runs")).toBe(1);

  const second = admitSubagentCompletionDelivery({
    ...input,
    databaseOptions: { database },
  });
  expect(second).toMatchObject({ claimed: false, status: "pending" });
  expect(rowCount("delivery_queue_entries")).toBe(1);

  const settledSubagent: SubagentRunRecord = structuredClone(input.subagent);
  settledSubagent.delivery!.status = "delivered";
  settledSubagent.delivery!.disposition = "delivered";
  const settledTask: TaskRecord = {
    ...input.task,
    deliveryStatus: "delivered",
  };
  settleSubagentCompletionDelivery({
    subagent: settledSubagent,
    task: settledTask,
    databaseOptions: { database },
  });
  const storedTask = database.db
    .prepare("SELECT delivery_status FROM task_runs WHERE task_id = ?")
    .get(input.task.taskId) as { delivery_status: string };
  expect(storedTask.delivery_status).toBe("delivered");

  clearRows();
  expect(() =>
    admitSubagentCompletionDelivery({
      ...records(),
      databaseOptions: { database },
      testHooks: { afterMutation: async () => undefined },
    }),
  ).toThrow("transaction hooks must be synchronous");
  expect(rowCount("delivery_queue_entries")).toBe(0);
  expect(rowCount("subagent_runs")).toBe(0);
  expect(rowCount("task_runs")).toBe(0);
}
