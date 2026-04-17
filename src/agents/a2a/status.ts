import { loadA2ATaskRecordFromEventLog } from "./log.js";
import type { A2ADeliveryMode, A2ATaskProtocolStatus, A2ATaskRecord } from "./types.js";

export type A2ATaskStatusCategory =
  | "active"
  | "terminal-success"
  | "terminal-failure"
  | "waiting-external"
  | "canceled"
  | "stale";

export type A2ATaskWorkerView =
  | "broker-queued"
  | "worker-running"
  | "worker-stale"
  | "waiting-reply"
  | "waiting-external"
  | "announce-pending"
  | "announce-sent"
  | "remote-failure"
  | "local-mismatch"
  | "done";

export type StaleConfig = {
  STALE_HEARTBEAT_MS: number;
  STALE_CRITICAL_MS: number;
  STALE_RUNNING_NO_HB_MS: number;
  DELIVERY_PENDING_STALE_MS: number;
};

export const DEFAULT_STALE_CONFIG: StaleConfig = {
  STALE_HEARTBEAT_MS: 120_000,
  STALE_CRITICAL_MS: 300_000,
  STALE_RUNNING_NO_HB_MS: 180_000,
  DELIVERY_PENDING_STALE_MS: 60_000,
};

export type A2ATaskStatusSnapshot = {
  taskId: string;
  executionStatus: A2ATaskRecord["execution"]["status"];
  deliveryStatus: A2ATaskRecord["delivery"]["status"];
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  acceptedAt?: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  heartbeatAt?: number;
  hasHeartbeat: boolean;
  statusCategory: A2ATaskStatusCategory;
  workerView: A2ATaskWorkerView;
  priority?: NonNullable<A2ATaskRecord["envelope"]["constraints"]>["priority"];
  intent: A2ATaskRecord["envelope"]["task"]["intent"];
};

export type A2ATaskDiagnostics = {
  ageMs: number;
  executionDurationMs?: number;
  lastHeartbeatAgeMs?: number;
  isStale: boolean;
  pendingSinceMs?: number;
};

export type A2ATaskDetailEntry = {
  taskId: string;
  correlationId?: string;
  parentRunId?: string;
  requester?: A2ATaskProtocolStatus["requester"];
  target: A2ATaskProtocolStatus["target"];
  executionStatus: A2ATaskProtocolStatus["executionStatus"];
  statusCategory: A2ATaskStatusCategory;
  workerView: A2ATaskWorkerView;
  createdAt: number;
  acceptedAt?: number;
  startedAt?: number;
  heartbeatAt?: number;
  updatedAt: number;
  completedAt?: number;
  deliveryStatus: A2ATaskProtocolStatus["deliveryStatus"];
  summary?: string;
  output?: unknown;
  error?: {
    code: string;
    message?: string;
  };
  errorCode?: string;
  errorMessage?: string;
  priority?: NonNullable<A2ATaskRecord["envelope"]["constraints"]>["priority"];
  intent: A2ATaskRecord["envelope"]["task"]["intent"];
  protocolStatus: A2ATaskProtocolStatus;
  instructions: string;
  input?: Record<string, unknown>;
  expectedOutput?: {
    format: "text" | "json";
    schemaName?: string;
  };
  timeoutSeconds?: number;
  maxPingPongTurns?: number;
  requireFinal?: boolean;
  allowAnnounce?: boolean;
  lastReplySummary?: string;
  delivery: {
    mode: A2ADeliveryMode;
    status: A2ATaskRecord["delivery"]["status"];
    updatedAt?: number;
    errorMessage?: string;
  };
  diagnostics: A2ATaskDiagnostics;
};

function resolveA2ATaskUpdatedAt(record: A2ATaskRecord): number {
  return Math.max(
    ...[
      record.delivery.updatedAt,
      record.execution.completedAt,
      record.execution.updatedAt,
      record.execution.heartbeatAt,
      record.execution.startedAt,
      record.execution.acceptedAt,
      record.execution.createdAt,
    ].filter((value): value is number => typeof value === "number"),
  );
}

function isDeliveryPending(record: A2ATaskRecord): boolean {
  return record.execution.status === "completed" && record.delivery.status === "pending";
}

function isLocalMismatch(record: A2ATaskRecord): boolean {
  return (
    record.execution.status === "completed" &&
    record.result?.output === undefined &&
    record.execution.errorCode === undefined &&
    (record.delivery.status === "none" || record.delivery.status === "skipped")
  );
}

export function isTaskStale(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): boolean {
  const updatedAt = resolveA2ATaskUpdatedAt(record);
  if (record.execution.status === "accepted") {
    return now - updatedAt >= config.STALE_HEARTBEAT_MS;
  }
  if (record.execution.status === "running") {
    if (typeof record.execution.heartbeatAt === "number") {
      return now - record.execution.heartbeatAt >= config.STALE_HEARTBEAT_MS;
    }
    if (typeof record.execution.startedAt === "number") {
      return now - record.execution.startedAt >= config.STALE_RUNNING_NO_HB_MS;
    }
  }
  return false;
}

export function isStaleCritical(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): boolean {
  if (!isTaskStale(record, now, config)) {
    return false;
  }
  const staleSince =
    record.execution.heartbeatAt ?? record.execution.startedAt ?? resolveA2ATaskUpdatedAt(record);
  return now - staleSince >= config.STALE_CRITICAL_MS;
}

export function deriveA2ATaskWorkerView(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): A2ATaskWorkerView {
  switch (record.execution.status) {
    case "accepted":
      return "broker-queued";
    case "running":
      return isTaskStale(record, now, config) ? "worker-stale" : "worker-running";
    case "waiting_reply":
      return "waiting-reply";
    case "waiting_external":
      return "waiting-external";
    case "completed":
      if (record.delivery.status === "pending") {
        return "announce-pending";
      }
      if (record.delivery.status === "sent") {
        return "announce-sent";
      }
      if (record.delivery.status === "failed") {
        return "remote-failure";
      }
      return isLocalMismatch(record) ? "local-mismatch" : "done";
    case "failed":
    case "timed_out":
      return "remote-failure";
    case "cancelled":
      return "done";
    default: {
      const _exhaustive: never = record.execution.status;
      return "done";
    }
  }
}

export function deriveA2ATaskStatusCategory(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): A2ATaskStatusCategory {
  switch (record.execution.status) {
    case "accepted":
    case "running":
      return isTaskStale(record, now, config) ? "stale" : "active";
    case "waiting_reply":
    case "waiting_external":
      return "waiting-external";
    case "completed":
      if (record.delivery.status === "pending") {
        return "active";
      }
      if (record.delivery.status === "failed") {
        return "terminal-failure";
      }
      return "terminal-success";
    case "failed":
    case "timed_out":
      return "terminal-failure";
    case "cancelled":
      return "canceled";
    default: {
      const _exhaustive: never = record.execution.status;
      return "active";
    }
  }
}

export function buildA2ATaskStatusSnapshot(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): A2ATaskStatusSnapshot {
  const updatedAt = resolveA2ATaskUpdatedAt(record);

  return {
    taskId: record.taskId,
    executionStatus: record.execution.status,
    deliveryStatus: record.delivery.status,
    summary: record.result?.summary,
    errorCode: record.execution.errorCode,
    errorMessage: record.execution.errorMessage,
    createdAt: record.execution.createdAt,
    acceptedAt: record.execution.acceptedAt,
    updatedAt,
    startedAt: record.execution.startedAt,
    completedAt: record.execution.completedAt,
    heartbeatAt: record.execution.heartbeatAt,
    hasHeartbeat: typeof record.execution.heartbeatAt === "number",
    statusCategory: deriveA2ATaskStatusCategory(record, now, config),
    workerView: deriveA2ATaskWorkerView(record, now, config),
    priority: record.envelope.constraints?.priority,
    intent: record.envelope.task.intent,
  };
}

export function buildA2ATaskProtocolStatus(record: A2ATaskRecord): A2ATaskProtocolStatus {
  const snapshot = buildA2ATaskStatusSnapshot(record);
  return {
    taskId: snapshot.taskId,
    correlationId: record.envelope.trace?.correlationId,
    parentRunId: record.envelope.trace?.parentRunId,
    requester: record.envelope.requester,
    target: record.envelope.target,
    executionStatus: snapshot.executionStatus,
    deliveryStatus: snapshot.deliveryStatus,
    summary: record.result?.summary,
    output: record.result?.output,
    error: snapshot.errorCode
      ? {
          code: snapshot.errorCode,
          message: snapshot.errorMessage,
        }
      : undefined,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt,
    heartbeatAt: snapshot.heartbeatAt,
    hasHeartbeat: snapshot.hasHeartbeat,
  };
}

export function buildA2ATaskDiagnostics(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): A2ATaskDiagnostics {
  const pendingAt = isDeliveryPending(record)
    ? (record.delivery.updatedAt ?? record.execution.completedAt)
    : undefined;
  return {
    ageMs: Math.max(0, now - record.execution.createdAt),
    executionDurationMs:
      typeof record.execution.startedAt === "number" &&
      typeof record.execution.completedAt === "number"
        ? Math.max(0, record.execution.completedAt - record.execution.startedAt)
        : undefined,
    lastHeartbeatAgeMs:
      typeof record.execution.heartbeatAt === "number"
        ? Math.max(0, now - record.execution.heartbeatAt)
        : undefined,
    isStale: isTaskStale(record, now, config),
    pendingSinceMs: typeof pendingAt === "number" ? Math.max(0, now - pendingAt) : undefined,
  };
}

export function buildA2ATaskDetailEntry(
  record: A2ATaskRecord,
  now = Date.now(),
  config: StaleConfig = DEFAULT_STALE_CONFIG,
): A2ATaskDetailEntry {
  const snapshot = buildA2ATaskStatusSnapshot(record, now, config);
  const protocolStatus = buildA2ATaskProtocolStatus(record);

  return {
    taskId: record.taskId,
    correlationId: protocolStatus.correlationId,
    parentRunId: protocolStatus.parentRunId,
    requester: protocolStatus.requester,
    target: protocolStatus.target,
    executionStatus: protocolStatus.executionStatus,
    statusCategory: snapshot.statusCategory,
    workerView: snapshot.workerView,
    createdAt: snapshot.createdAt,
    acceptedAt: snapshot.acceptedAt,
    startedAt: snapshot.startedAt,
    heartbeatAt: snapshot.heartbeatAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.completedAt,
    deliveryStatus: snapshot.deliveryStatus,
    summary: record.result?.summary,
    output: record.result?.output,
    error: protocolStatus.error,
    errorCode: snapshot.errorCode,
    errorMessage: snapshot.errorMessage,
    priority: snapshot.priority,
    intent: snapshot.intent,
    protocolStatus,
    instructions: record.envelope.task.instructions,
    input: record.envelope.task.input,
    expectedOutput: record.envelope.task.expectedOutput,
    timeoutSeconds: record.envelope.constraints?.timeoutSeconds,
    maxPingPongTurns: record.envelope.constraints?.maxPingPongTurns,
    requireFinal: record.envelope.constraints?.requireFinal,
    allowAnnounce: record.envelope.constraints?.allowAnnounce,
    lastReplySummary: record.result?.summary,
    delivery: {
      mode: record.delivery.mode,
      status: record.delivery.status,
      updatedAt: record.delivery.updatedAt,
      errorMessage: record.delivery.errorMessage,
    },
    diagnostics: buildA2ATaskDiagnostics(record, now, config),
  };
}

export function classifyA2AExecutionStatus(
  status: A2ATaskRecord["execution"]["status"],
): A2ATaskStatusCategory {
  switch (status) {
    case "completed":
      return "terminal-success";
    case "failed":
    case "timed_out":
    case "cancelled":
      return "terminal-failure";
    default:
      return "active";
  }
}

export async function loadA2ATaskScopedRecord(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  allowTaskToken?: boolean;
}): Promise<A2ATaskRecord | undefined> {
  let record: A2ATaskRecord | undefined;
  try {
    record = await loadA2ATaskRecordFromEventLog(params);
  } catch {
    return undefined;
  }
  if (!record || record.envelope.target.sessionKey !== params.sessionKey) {
    return undefined;
  }
  if (!params.allowTaskToken && record.taskId !== params.taskId) {
    return undefined;
  }
  return record;
}

export async function loadA2ATaskStatusSnapshot(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskStatusSnapshot | undefined> {
  const record = await loadA2ATaskScopedRecord(params);
  if (!record) {
    return undefined;
  }
  return buildA2ATaskStatusSnapshot(record, params.now, params.staleConfig);
}

export async function loadA2ATaskProtocolStatus(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskProtocolStatus | undefined> {
  const record = await loadA2ATaskScopedRecord(params);
  if (!record) {
    return undefined;
  }
  return buildA2ATaskProtocolStatus(record);
}

export async function loadA2ATaskDetail(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  staleConfig?: StaleConfig;
}): Promise<A2ATaskDetailEntry | undefined> {
  const record = await loadA2ATaskScopedRecord(params);
  if (!record) {
    return undefined;
  }
  return buildA2ATaskDetailEntry(record, params.now, params.staleConfig);
}

/** Returns true if the execution status represents a terminal (non-active) state. */
export function isTerminalExecutionStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}
