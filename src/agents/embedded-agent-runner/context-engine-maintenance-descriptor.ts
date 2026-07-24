/**
 * Task-descriptor builders and terminal-state helpers for deferred
 * context-engine turn maintenance. These own the maintenance task's identity
 * (kind/label/task text) and its notify/delivery visibility transitions.
 */
import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createQueuedTaskRun } from "../../tasks/detached-task-runtime.js";
import { cancelTaskByIdForOwner } from "../../tasks/task-owner-access.js";
import { log } from "./logger.js";

export const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_TASK_LABEL = "Context engine turn maintenance";
const TURN_MAINTENANCE_TASK_TASK = "Deferred context-engine maintenance after turn.";

export function markDeferredTurnMaintenanceTaskScheduleFailure(params: {
  sessionKey: string;
  taskId: string;
  error: unknown;
}): void {
  const errorMessage = formatErrorMessage(params.error);
  log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
  cancelTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.sessionKey,
    endedAt: Date.now(),
    terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
  });
}

export function markDeferredTurnMaintenanceTaskTimeout(params: {
  sessionKey: string;
  taskId: string;
  timeoutMs: number;
}): void {
  log.warn(
    `deferred context engine maintenance timed out: sessionKey=${params.sessionKey} ` +
      `taskId=${params.taskId} taskTimeoutMs=${params.timeoutMs}`,
  );
  cancelTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.sessionKey,
    endedAt: Date.now(),
    terminalSummary: `Deferred maintenance timed out after ${params.timeoutMs}ms.`,
  });
}

export function buildTurnMaintenanceTaskDescriptor(params: {
  sessionKey: string;
  runId?: string;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  deliveryStatus?: "not_applicable" | "pending";
}) {
  const runId =
    params.runId ??
    `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
    sourceId: TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: TURN_MAINTENANCE_TASK_LABEL,
    task: TURN_MAINTENANCE_TASK_TASK,
    notifyPolicy: params.notifyPolicy ?? "silent",
    // Fast maintenance stays silent and must not create a one-task flow.
    // Long-running and failed workers promote it to pending before notifying.
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    preferMetadata: true,
  });
}

export function promoteTurnMaintenanceTaskVisibility(params: {
  sessionKey: string;
  runId: string;
  notifyPolicy: "done_only" | "state_changes";
}) {
  return buildTurnMaintenanceTaskDescriptor({
    sessionKey: params.sessionKey,
    runId: params.runId,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: "pending",
  });
}
