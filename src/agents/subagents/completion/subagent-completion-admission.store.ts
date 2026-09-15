import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import {
  getDeliveryQueueEntryOwnersInDatabase,
  type DeliveryQueueStoredStatus,
} from "../../../infra/delivery-queue-sqlite.kernel.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveEventSessionKey } from "../../../routing/session-key.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../../../tasks/task-completion-contract.js";
import { formatTaskBlockedFollowupMessage } from "../../../tasks/task-executor-policy.js";
import { syncFlowFromTaskAfterTaskMutation } from "../../../tasks/task-registry-state.js";
import {
  bindTaskRecord,
  findTaskRecordByRunIdForViewInDatabase,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.kernel.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { resolveTaskCleanupAfter } from "../../../tasks/task-retention.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  isCompletedRequesterDeliveryBlocked,
} from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { resolveFinalizedSubagentTaskState } from "../registry/subagent-registry-completion.js";
import {
  loadPendingFinalDeliveryPayload,
  markRequesterSettleWakePending,
} from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  bindSubagentRunRecord,
  loadSubagentRunsForChildSessionFromSqlite,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";

const log = createSubsystemLogger("subagents/completion");

export const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;

type AdmissionTestHooks = {
  afterBind?: () => unknown;
  afterMutation?: (
    phase: "queue" | "subagent" | "task",
    database: OpenClawStateDatabase,
  ) => unknown;
};

function invokeSynchronousHook(hook: (() => unknown) | undefined): void {
  const result = hook?.();
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error("subagent completion admission transaction hooks must be synchronous");
  }
}

function publishCommittedSubagent(subagent: SubagentRunRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    for (const key of Object.keys(live)) {
      Reflect.deleteProperty(live, key);
    }
    Object.assign(live, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
}

export function publishCommittedRecords(subagent: SubagentRunRecord, task: TaskRecord): void {
  publishCommittedSubagent(subagent);
  const deferredObserverEvents: Array<() => void> = [];
  const published = publishTaskRecordAfterAtomicStore(task, { deferredObserverEvents });
  syncFlowFromTaskAfterTaskMutation(published, "atomic completion admission");
  for (const emitObserverEvent of deferredObserverEvents) {
    emitObserverEvent();
  }
}

function assertCorrelatedEntry(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
}): void {
  const owner = params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
  const delivery = params.subagent.delivery;
  if (
    !owner ||
    owner.kind !== "subagent_completion" ||
    owner.runId !== params.subagent.runId ||
    owner.taskId !== params.task.taskId ||
    owner.generation !== delivery?.generation ||
    owner.deadlineAt !== delivery.deadlineAt ||
    params.queueEntry.id !== delivery.queueId ||
    params.task.deliveryStatus !== "session_queued"
  ) {
    throw new Error("subagent completion admission records do not share one owner generation");
  }
}

/**
 * Commits the physical queue generation, logical completion owner, and task
 * projection as one database-only transaction on one exact shared-state handle.
 */
export function admitSubagentCompletionDelivery(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  /** Transaction cut points used by the real-store crash-consistency tests. */
  testHooks?: AdmissionTestHooks;
}): { claimed: boolean; status: DeliveryQueueStoredStatus } {
  assertCorrelatedEntry(params);
  const boundQueue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry: params.queueEntry,
    insertOnly: true,
  });
  const boundSubagent = bindSubagentRunRecord(params.subagent);
  const boundTask = bindTaskRecord(params.task);
  invokeSynchronousHook(params.testHooks?.afterBind);

  return runOpenClawStateWriteTransaction(
    (database) => {
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("queue", database));
      if (!claimed) {
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          params.queueEntry.id,
        ) as QueuedSessionDelivery | null;
        const expectedOwner =
          params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (
          !existingOwner ||
          !expectedOwner ||
          existingOwner.kind !== expectedOwner.kind ||
          existingOwner.runId !== expectedOwner.runId ||
          existingOwner.taskId !== expectedOwner.taskId ||
          existingOwner.generation !== expectedOwner.generation ||
          existingOwner.deadlineAt !== expectedOwner.deadlineAt
        ) {
          throw new Error(`session delivery queue conflict for ${params.queueEntry.id}`);
        }
      }
      upsertSubagentRunRowInDatabase(database, boundSubagent);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("subagent", database));
      upsertTaskRunRowInDatabase(database, boundTask);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("task", database));
      const status =
        getDeliveryQueueEntryOwnersInDatabase(
          database,
          [SESSION_DELIVERY_QUEUE_NAME],
          params.queueEntry.id,
        ).get(SESSION_DELIVERY_QUEUE_NAME)?.status ?? "pending";
      return { claimed, status };
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery admission" },
  );
}

/** Atomically consumes a correlated queue settlement into registry and task projections. */
export function settleSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  mutateSubagent?: (entry: SubagentRunRecord) => unknown;
}): void {
  const boundTask = bindTaskRecord(params.task);
  runOpenClawStateWriteTransaction(
    (database) => {
      invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(params.subagent));
      upsertTaskRunRowInDatabase(database, boundTask);
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery settlement" },
  );
}

function retiredCancellationEndedAt(subagent: SubagentRunRecord, now: number): number | undefined {
  const endedAt = subagent.execution.endedAt;
  if (
    subagent.execution.status !== "terminal" ||
    subagent.execution.outcome?.status !== "error" ||
    subagent.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
    typeof endedAt !== "number" ||
    !Number.isFinite(endedAt) ||
    typeof subagent.cleanupCompletedAt !== "number" ||
    !Number.isFinite(subagent.cleanupCompletedAt) ||
    subagent.cleanupCompletedAt < endedAt ||
    subagent.pauseReason ||
    subagent.killIntent ||
    subagent.terminalOwner ||
    subagent.execution.restartRecovery ||
    subagent.suppressAnnounceReason === "steer-restart" ||
    subagent.expectsCompletionMessage !== true ||
    subagent.completion?.required !== true ||
    !subagent.requesterSettleWake ||
    subagent.delivery?.status !== "pending" ||
    subagent.delivery.queueId ||
    resolveTaskCleanupAfter({ status: "cancelled", endedAt, createdAt: subagent.createdAt }) > now
  ) {
    return undefined;
  }
  return endedAt;
}

function ownsRetiredCancellation(
  database: OpenClawStateDatabase,
  subagent: SubagentRunRecord,
  expected: SubagentRunRecord,
): boolean {
  const newerSibling = (candidate: SubagentRunRecord) =>
    candidate.childSessionKey === subagent.childSessionKey &&
    compareSubagentRunGeneration(candidate, subagent) > 0;
  return (
    subagentRuns.get(subagent.runId) === expected &&
    bindSubagentRunRecord(subagent).payload_json === bindSubagentRunRecord(expected).payload_json &&
    !findTaskRecordByRunIdForViewInDatabase(database.db, subagent.taskRunId ?? subagent.runId) &&
    ![...subagentRuns.values()].some(newerSibling) &&
    !loadSubagentRunsForChildSessionFromSqlite(subagent.childSessionKey, database).some(
      newerSibling,
    )
  );
}

/** A changed historical owner stays deferred instead of falling through to repeat cleanup. */
export function reconcileRetiredSubagentCancellation(
  expected: SubagentRunRecord,
  now: number,
): boolean | undefined {
  const endedAt = retiredCancellationEndedAt(expected, now);
  const marker = expected.killReconciliation;
  if (
    endedAt === undefined ||
    !marker ||
    !Number.isFinite(marker.killedAt) ||
    marker.killedAt > endedAt
  ) {
    return undefined;
  }
  return runOpenClawStateWriteTransaction((database) => {
    const subagent = readSubagentRun(database, expected.runId);
    if (!subagent || retiredCancellationEndedAt(subagent, now) !== endedAt) {
      return false;
    }
    // Retained tasks still use ordinary cancellation and requester-wake ordering.
    if (findTaskRecordByRunIdForViewInDatabase(database.db, subagent.taskRunId ?? subagent.runId)) {
      return undefined;
    }
    if (!ownsRetiredCancellation(database, subagent, expected)) {
      return false;
    }
    subagent.killReconciliation = undefined;
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
    deferSqlitePostCommitPublication(database.db, () => publishCommittedSubagent(subagent));
    return true;
  });
}

export function blockSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  taskId: string;
  reason: string;
  suspendedReason?: "expiry" | "permanent_failure";
  lastDropReason?: NonNullable<SubagentRunRecord["delivery"]>["lastDropReason"];
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
  databaseOptions?: OpenClawStateDatabaseOptions;
}): boolean {
  const generation = params.subagent.delivery?.generation ?? 1;
  const now = Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const subagent = readSubagentRun(database, params.subagent.runId);
    const task = readTaskRecord(database.db, params.taskId);
    if (subagent && !task && !params.taskId && params.suspendedReason === undefined) {
      const endedAt = retiredCancellationEndedAt(subagent, now);
      // Old cancellation cleanup can outlive its task's retention window.
      // Recover that exact completed owner without recreating historical work.
      if (
        endedAt === undefined ||
        subagent.killReconciliation ||
        !ownsRetiredCancellation(database, subagent, params.subagent)
      ) {
        return false;
      }
      const completion = ensureCompletionState(subagent);
      const delivery = ensureDeliveryState(subagent);
      completion.resultText ??= null;
      completion.capturedAt ??= endedAt;
      Object.assign(delivery, {
        status: "failed" as const,
        disposition: params.disposition ?? delivery.disposition,
        lastError: params.reason,
        nextAttemptAt: undefined,
      });
      subagent.suppressCompletionDelivery = true;
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
      deferSqlitePostCommitPublication(database.db, () => publishCommittedSubagent(subagent));
      return true;
    }
    if (
      !subagent ||
      !task ||
      task.runtime !== "subagent" ||
      subagent.execution.status !== "terminal" ||
      subagent.expectsCompletionMessage !== true ||
      (subagent.taskRunId ?? subagent.runId) !== task.runId ||
      (subagent.delivery?.generation ?? 1) !== generation
    ) {
      return false;
    }
    const successful = task.status === "succeeded" && subagent.execution.outcome?.status === "ok";
    // A terminal non-success still owns its failed requester wake. Classify the
    // persisted pair; a missing or superseded owner is not permission to settle.
    if (
      !successful &&
      (params.suspendedReason !== undefined ||
        !["cancelled", "failed", "timed_out"].includes(task.status) ||
        resolveFinalizedSubagentTaskState(subagent)?.status !== task.status ||
        !["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending"))
    ) {
      return false;
    }
    const delivery = ensureDeliveryState(subagent);
    delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
    Object.assign(delivery, {
      status: params.suspendedReason ? ("suspended" as const) : ("failed" as const),
      disposition: params.suspendedReason
        ? ("permanent_failure" as const)
        : (params.disposition ?? delivery.disposition),
      lastError: params.reason,
      deliveredAt: undefined,
      announcedAt: undefined,
      suspendedAt: params.suspendedReason ? (delivery.suspendedAt ?? now) : delivery.suspendedAt,
      suspendedReason: params.suspendedReason ?? delivery.suspendedReason,
      lastDropReason: params.lastDropReason ?? delivery.lastDropReason,
      nextAttemptAt: undefined,
      queueId: undefined,
    });
    Object.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: undefined });
    if (params.suspendedReason) {
      if (isCompletedRequesterDeliveryBlocked(subagent)) {
        // This requester already ran. An ordinary settle wake would replay it;
        // a separately owned yield batch still has genuine unfinished work.
        if (subagent.requesterSettleWake?.requesterYieldBatch !== true) {
          subagent.requesterSettleWake = undefined;
        }
      } else {
        markRequesterSettleWakePending(subagent);
      }
    } else {
      subagent.suppressCompletionDelivery = true;
    }
    if (successful) {
      const terminal = resolveRequiredCompletionDeliveryFailureTerminalResult(params.reason);
      Object.assign(task, {
        ...terminal,
        error: params.reason,
        cleanupAfter: Math.max(task.cleanupAfter ?? 0, now + SUSPENDED_RETENTION_MS),
      });
    }
    Object.assign(task, {
      deliveryStatus: "failed" as const,
      lastEventAt: now,
    });
    const text =
      successful && task.notifyPolicy !== "silent" ? formatTaskBlockedFollowupMessage(task) : null;
    const queued = text
      ? prepareClaimedSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: resolveEventSessionKey(task.requesterSessionKey),
            ...(task.requesterAgentId ? { agentId: task.requesterAgentId } : {}),
            text,
            ...(subagent.requesterOrigin ? { deliveryContext: subagent.requesterOrigin } : {}),
            idempotencyKey: `subagent-completion-blocked:${task.taskId}:generation:${generation}`,
          },
          0,
          now,
        )
      : undefined;
    if (queued) {
      upsertBoundDeliveryQueueEntryInDatabase(
        bindDeliveryQueueEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          entry: queued,
          insertOnly: true,
        }),
        database,
      );
    }
    settleSubagentCompletionDelivery({
      subagent,
      task,
      databaseOptions: { database },
    });
    deferSqlitePostCommitPublication(database.db, () => {
      publishCommittedRecords(subagent, task);
      if (queued) {
        void (async () => {
          const queueContext = captureOpenClawStateWorkerContext({
            path: database.path,
            env: params.databaseOptions?.env,
          });
          await scheduleSessionDelivery(queued.id, queueContext);
        })().catch((error: unknown) => {
          log.warn("Subagent completion remains queued after scheduling failed", {
            queueId: queued.id,
            error,
          });
        });
      }
    });
    return true;
  }, params.databaseOptions);
}
