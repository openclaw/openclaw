import { randomUUID } from "node:crypto";
import { CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND as TURN_MAINTENANCE_TASK_KIND } from "../../tasks/context-engine-maintenance-task-owner.js";
import { createQueuedTaskRun } from "../../tasks/detached-task-runtime.js";

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
    label: "Context engine turn maintenance",
    task: "Deferred context-engine maintenance after turn.",
    notifyPolicy: params.notifyPolicy ?? "silent",
    // Fast maintenance stays silent and must not create a one-task flow.
    // Long-running and failed workers promote it to pending before notifying.
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    preferMetadata: true,
  });
}
