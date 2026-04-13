import type { A2AExecutionStatus, A2ATaskEnvelopeV1, A2ATaskEvent } from "./types.js";

export function createA2ATaskCreatedEvent(params: {
  envelope: A2ATaskEnvelopeV1;
  at?: number;
}): A2ATaskEvent {
  return {
    type: "task.created",
    taskId: params.envelope.taskId,
    at: params.at ?? Date.now(),
    envelope: params.envelope,
  };
}

export function createA2ATaskAcceptedEvent(params: { taskId: string; at?: number }): A2ATaskEvent {
  return {
    type: "task.accepted",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
  };
}

export function createA2ATaskUpdatedEvent(params: {
  taskId: string;
  at?: number;
  executionStatus?: Exclude<A2AExecutionStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  summary?: string;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
}): A2ATaskEvent {
  return {
    type: "task.updated",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    executionStatus: params.executionStatus,
    summary: params.summary,
    output: params.output,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  };
}

export function createA2AWorkerStartedEvent(params: { taskId: string; at?: number }): A2ATaskEvent {
  return {
    type: "worker.started",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
  };
}

export function createA2AWorkerHeartbeatEvent(params: {
  taskId: string;
  at?: number;
}): A2ATaskEvent {
  return {
    type: "worker.heartbeat",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
  };
}

export function createA2AWorkerReplyEvent(params: {
  taskId: string;
  at?: number;
  text?: string;
}): A2ATaskEvent {
  return {
    type: "worker.reply",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    text: params.text,
  };
}

export function createA2ATaskCompletedEvent(params: {
  taskId: string;
  at?: number;
  summary?: string;
  output?: unknown;
}): A2ATaskEvent {
  return {
    type: "task.completed",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    summary: params.summary,
    output: params.output,
  };
}

export function createA2ATaskFailedEvent(params: {
  taskId: string;
  at?: number;
  errorCode: string;
  errorMessage?: string;
}): A2ATaskEvent {
  return {
    type: "task.failed",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  };
}

export function createA2ATaskCancelledEvent(params: {
  taskId: string;
  at?: number;
  reason?: string;
}): A2ATaskEvent {
  return {
    type: "task.cancelled",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    reason: params.reason,
  };
}

export function createA2ATaskTimedOutEvent(params: {
  taskId: string;
  at?: number;
  errorMessage?: string;
}): A2ATaskEvent {
  return {
    type: "task.timed_out",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    errorMessage: params.errorMessage,
  };
}

export function createA2ADeliverySentEvent(params: { taskId: string; at?: number }): A2ATaskEvent {
  return {
    type: "delivery.sent",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
  };
}

export function createA2ADeliverySkippedEvent(params: {
  taskId: string;
  at?: number;
}): A2ATaskEvent {
  return {
    type: "delivery.skipped",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
  };
}

export function createA2ADeliveryFailedEvent(params: {
  taskId: string;
  at?: number;
  errorMessage?: string;
}): A2ATaskEvent {
  return {
    type: "delivery.failed",
    taskId: params.taskId,
    at: params.at ?? Date.now(),
    errorMessage: params.errorMessage,
  };
}
