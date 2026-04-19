import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowRecord,
} from "../plugins/runtime/runtime-taskflow.types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";

export const ACP_TASKFLOW_CONTROLLER_ID = "agents/acp-spawn";

export function ensureAcpManagedFlow(params: {
  taskFlow: BoundTaskFlowRuntime;
  controllerId?: string;
  goal: string;
  currentStep?: string;
  routeSnapshot?: BoundTaskFlowRuntime["requesterOrigin"];
  workflowIntent?: Record<string, string>;
}): ManagedTaskFlowRecord {
  const routeSnapshot = normalizeDeliveryContext(params.routeSnapshot);
  return params.taskFlow.createManaged({
    controllerId: params.controllerId ?? ACP_TASKFLOW_CONTROLLER_ID,
    goal: params.goal,
    status: "running",
    currentStep: params.currentStep ?? "spawn-acp-child",
    stateJson: {
      ...(routeSnapshot ? { route: routeSnapshot } : {}),
      ...(params.workflowIntent ? { workflowIntent: params.workflowIntent } : {}),
    },
  });
}

export function syncAcpManagedFlowTerminalState(
  task: Pick<
    TaskRecord,
    | "taskId"
    | "parentFlowId"
    | "status"
    | "terminalOutcome"
    | "terminalSummary"
    | "lastEventAt"
    | "endedAt"
  >,
): void {
  const flowId = normalizeOptionalString(task.parentFlowId);
  if (!flowId) {
    return;
  }
  let flow = getTaskFlowById(flowId);
  const endedAt = task.endedAt ?? task.lastEventAt ?? Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      !flow ||
      flow.syncMode !== "managed" ||
      flow.controllerId !== ACP_TASKFLOW_CONTROLLER_ID ||
      flow.status === "succeeded" ||
      flow.status === "failed" ||
      flow.status === "cancelled" ||
      flow.status === "lost"
    ) {
      return;
    }
    const patch =
      task.status === "succeeded" && task.terminalOutcome === "blocked"
        ? {
            status: "blocked" as const,
            blockedTaskId: task.taskId,
            blockedSummary: normalizeOptionalString(task.terminalSummary) ?? null,
            waitJson: null,
            endedAt,
            updatedAt: endedAt,
          }
        : task.status === "succeeded"
          ? {
              status: "succeeded" as const,
              blockedTaskId: null,
              blockedSummary: null,
              waitJson: null,
              endedAt,
              updatedAt: endedAt,
            }
          : {
              status: "failed" as const,
              blockedTaskId: null,
              blockedSummary: null,
              waitJson: null,
              endedAt,
              updatedAt: endedAt,
            };
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: flow.revision,
      patch,
    });
    if (result.applied || result.reason === "not_found") {
      return;
    }
    flow = result.current;
  }
}
