import type { A2ADeliveryMode, A2ATaskEnvelopeV1, A2ATaskEvent, A2ATaskRecord } from "./types.js";

export function createA2ATaskRecord(params: {
  envelope: A2ATaskEnvelopeV1;
  now?: number;
  deliveryMode?: A2ADeliveryMode;
}): A2ATaskRecord {
  const now = params.now ?? Date.now();
  return {
    taskId: params.envelope.taskId,
    envelope: params.envelope,
    execution: {
      status: "accepted",
      createdAt: now,
      acceptedAt: now,
      updatedAt: now,
    },
    delivery: {
      status: params.deliveryMode === "silent" ? "none" : "pending",
      mode: params.deliveryMode ?? "announce",
      updatedAt: now,
    },
  };
}

export function applyA2ATaskEvent(record: A2ATaskRecord, event: A2ATaskEvent): A2ATaskRecord {
  if (event.taskId !== record.taskId) {
    return record;
  }

  switch (event.type) {
    case "task.created":
      return {
        ...record,
        taskId: event.taskId,
        envelope: event.envelope,
        execution: {
          ...record.execution,
          createdAt: event.at,
          updatedAt: event.at,
        },
      };
    case "task.accepted":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "accepted",
          acceptedAt: event.at,
          updatedAt: event.at,
        },
      };
    case "task.updated":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: event.executionStatus ?? record.execution.status,
          updatedAt: event.at,
          errorCode: event.errorCode ?? record.execution.errorCode,
          errorMessage: event.errorMessage ?? record.execution.errorMessage,
        },
        result: {
          ...record.result,
          summary: event.summary ?? record.result?.summary,
          output: event.output ?? record.result?.output,
        },
      };
    case "worker.started":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "running",
          startedAt: event.at,
          updatedAt: event.at,
        },
      };
    case "worker.heartbeat":
      return {
        ...record,
        execution: {
          ...record.execution,
          heartbeatAt: event.at,
          updatedAt: event.at,
        },
      };
    case "worker.reply":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "waiting_reply",
          heartbeatAt: event.at,
          updatedAt: event.at,
        },
        result: {
          ...record.result,
          summary: event.text ?? record.result?.summary,
        },
      };
    case "task.completed":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "completed",
          completedAt: event.at,
          updatedAt: event.at,
        },
        result: {
          summary: event.summary ?? record.result?.summary,
          output: event.output,
        },
      };
    case "task.failed":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "failed",
          completedAt: event.at,
          updatedAt: event.at,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
        },
      };
    case "task.cancelled":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "cancelled",
          completedAt: event.at,
          updatedAt: event.at,
          errorCode: "cancelled",
          errorMessage: event.reason,
        },
      };
    case "task.timed_out":
      return {
        ...record,
        execution: {
          ...record.execution,
          status: "timed_out",
          completedAt: event.at,
          updatedAt: event.at,
          errorCode: "timeout",
          errorMessage: event.errorMessage,
        },
      };
    case "delivery.sent":
      return {
        ...record,
        delivery: {
          ...record.delivery,
          status: "sent",
          updatedAt: event.at,
        },
      };
    case "delivery.skipped":
      return {
        ...record,
        delivery: {
          ...record.delivery,
          status: "skipped",
          updatedAt: event.at,
        },
      };
    case "delivery.failed":
      return {
        ...record,
        delivery: {
          ...record.delivery,
          status: "failed",
          updatedAt: event.at,
          errorMessage: event.errorMessage,
        },
      };
  }

  return record;
}
