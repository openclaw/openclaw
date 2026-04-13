import { loadA2ATaskRecordFromEventLog } from "./log.js";
import type { A2ATaskProtocolStatus, A2ATaskRecord } from "./types.js";

export type A2ATaskStatusSnapshot = {
  taskId: string;
  executionStatus: A2ATaskRecord["execution"]["status"];
  deliveryStatus: A2ATaskRecord["delivery"]["status"];
  summary?: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: number;
  hasHeartbeat: boolean;
};

export function buildA2ATaskStatusSnapshot(record: A2ATaskRecord): A2ATaskStatusSnapshot {
  const updatedAt = Math.max(
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

  return {
    taskId: record.taskId,
    executionStatus: record.execution.status,
    deliveryStatus: record.delivery.status,
    summary: record.result?.summary,
    errorCode: record.execution.errorCode,
    errorMessage: record.execution.errorMessage,
    updatedAt,
    hasHeartbeat: typeof record.execution.heartbeatAt === "number",
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
    hasHeartbeat: snapshot.hasHeartbeat,
  };
}

export async function loadA2ATaskStatusSnapshot(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskStatusSnapshot | undefined> {
  const record = await loadA2ATaskRecordFromEventLog(params);
  if (!record) {
    return undefined;
  }
  return buildA2ATaskStatusSnapshot(record);
}

export async function loadA2ATaskProtocolStatus(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskProtocolStatus | undefined> {
  const record = await loadA2ATaskRecordFromEventLog(params);
  if (!record) {
    return undefined;
  }
  return buildA2ATaskProtocolStatus(record);
}
