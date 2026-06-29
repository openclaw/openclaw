// Maps Durable Core coordination projections into Workboard card patches.
import type { WorkboardCardPatch } from "./store.js";
import type {
  WorkboardDurableChildCounts,
  WorkboardDurableMetadata,
  WorkboardStatus,
} from "./types.js";

type DurableProjectionLike = {
  workflowRunId?: unknown;
  workflowId?: unknown;
  workflowVersion?: unknown;
  status?: unknown;
  recoveryState?: unknown;
  waitingReason?: unknown;
  currentStepId?: unknown;
  updatedAt?: unknown;
  external?: unknown;
  children?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function childCounts(value: unknown): WorkboardDurableChildCounts | undefined {
  const record = recordValue(value);
  const next: WorkboardDurableChildCounts = {};
  for (const key of [
    "total",
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "lost",
    "terminal",
    "open",
  ] as const) {
    const count = numberValue(record[key]);
    if (count !== undefined) {
      next[key] = Math.max(0, Math.trunc(count));
    }
  }
  return Object.keys(next).length ? next : undefined;
}

function statusFromDurable(status: string | undefined): WorkboardStatus | undefined {
  switch (status) {
    case "received":
    case "queued":
    case "running":
    case "waiting":
    case "waiting_signal":
    case "waiting_timer":
    case "waiting_child":
    case "retry_scheduled":
      return "running";
    case "succeeded":
      return "review";
    case "failed":
    case "cancelled":
    case "lost":
      return "blocked";
    default:
      return undefined;
  }
}

export function buildWorkboardDurableMetadata(
  projection: DurableProjectionLike,
): WorkboardDurableMetadata | undefined {
  const external = recordValue(projection.external);
  const workflowRunId = stringValue(projection.workflowRunId);
  if (!workflowRunId) {
    return undefined;
  }
  const updatedAt = numberValue(projection.updatedAt) ?? Date.now();
  const children = childCounts(projection.children);
  const workflowId = stringValue(projection.workflowId);
  const workflowVersion = stringValue(projection.workflowVersion);
  const status = stringValue(projection.status);
  const recoveryState = stringValue(projection.recoveryState);
  const waitingReason = stringValue(projection.waitingReason);
  const currentStepId = stringValue(projection.currentStepId);
  const taskId = stringValue(external.taskId);
  const taskFlowId = stringValue(external.taskFlowId);
  const sessionKey = stringValue(external.sessionKey);
  const childSessionKey = stringValue(external.childSessionKey);
  const runId = stringValue(external.runId);
  const agentId = stringValue(external.agentId);
  const requesterAgentId = stringValue(external.requesterAgentId);
  return {
    workflowRunId,
    ...(workflowId ? { workflowId } : {}),
    ...(workflowVersion ? { workflowVersion } : {}),
    ...(status ? { status } : {}),
    ...(recoveryState ? { recoveryState } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(currentStepId ? { currentStepId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskFlowId ? { taskFlowId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(childSessionKey ? { childSessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(requesterAgentId ? { requesterAgentId } : {}),
    timelineCommand: `openclaw durable timeline ${workflowRunId}`,
    ...(children ? { children } : {}),
    updatedAt,
  };
}

export function buildWorkboardPatchFromDurableProjection(
  projection: DurableProjectionLike,
): WorkboardCardPatch {
  const durable = buildWorkboardDurableMetadata(projection);
  if (!durable) {
    return {};
  }
  const status = statusFromDurable(durable.status);
  return {
    ...(status ? { status } : {}),
    ...((durable.sessionKey ?? durable.childSessionKey)
      ? { sessionKey: durable.sessionKey ?? durable.childSessionKey }
      : {}),
    ...(durable.runId ? { runId: durable.runId } : {}),
    ...(durable.taskId ? { taskId: durable.taskId } : {}),
    metadata: {
      durable,
      lifecycleStatusSourceUpdatedAt: durable.updatedAt,
    },
  };
}
