import crypto from "node:crypto";
import {
  createA2ADeliveryFailedEvent,
  createA2ADeliverySentEvent,
  createA2ADeliverySkippedEvent,
  createA2ATaskAcceptedEvent,
  createA2ATaskCancelledEvent,
  createA2ATaskCompletedEvent,
  createA2ATaskCreatedEvent,
  createA2ATaskFailedEvent,
  createA2ATaskTimedOutEvent,
  createA2ATaskUpdatedEvent,
  createA2AWorkerHeartbeatEvent,
  createA2AWorkerReplyEvent,
  createA2AWorkerStartedEvent,
} from "./events.js";
import { createA2ATaskEventLogSink } from "./log.js";
import { loadA2ATaskRecordFromEventLog } from "./log.js";
import { buildA2ATaskProtocolStatus, loadA2ATaskProtocolStatus } from "./status.js";
import { applyA2ATaskEvent, createA2ATaskRecord } from "./store.js";
import type {
  A2ABrokerRuntime,
  A2AExchangeRequest,
  A2ATaskCancel,
  A2ATaskCancelResult,
  A2ATaskEvent,
  A2ATaskEventSink,
  A2ATaskProtocolStatus,
  A2ATaskRecord,
  A2ATaskRequest,
  A2ATaskRequestResult,
  A2ATaskUpdate,
  A2ATaskUpdateResult,
  A2ATaskEnvelopeV1,
} from "./types.js";

function summarizeInstructions(message: string): string {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return "Agent-to-agent task";
  }
  return trimmedMessage.length > 120 ? `${trimmedMessage.slice(0, 117)}...` : trimmedMessage;
}

export function buildA2ATaskRequestFromExchange(params: {
  request: A2AExchangeRequest;
  taskId?: string;
  correlationId?: string;
}): A2ATaskRequest {
  const { request } = params;
  return {
    method: "a2a.task.request",
    taskId: params.taskId ?? request.waitRunId,
    correlationId: params.correlationId ?? request.waitRunId,
    parentRunId: request.waitRunId,
    requester: request.requester,
    target: request.target,
    task: {
      intent: "delegate",
      summary: summarizeInstructions(request.originalMessage),
      instructions: request.originalMessage,
      input: {
        originalMessage: request.originalMessage,
        roundOneReply: request.roundOneReply,
      },
      expectedOutput: {
        format: "text",
      },
    },
    constraints: {
      timeoutSeconds: Math.max(1, Math.ceil(request.announceTimeoutMs / 1000)),
      maxPingPongTurns: request.maxPingPongTurns,
      requireFinal: false,
      allowAnnounce: true,
      priority: "normal",
    },
    runtime: {
      announceTimeoutMs: request.announceTimeoutMs,
      maxPingPongTurns: request.maxPingPongTurns,
      roundOneReply: request.roundOneReply,
      waitRunId: request.waitRunId,
    },
  };
}

export function buildA2ATaskEnvelopeFromRequest(params: {
  request: A2ATaskRequest;
  taskId?: string;
}): A2ATaskEnvelopeV1 {
  const { request } = params;
  const resolvedTaskId = params.taskId ?? request.taskId ?? crypto.randomUUID();
  const summary = request.task.summary?.trim() || summarizeInstructions(request.task.instructions);

  return {
    v: 1,
    taskId: resolvedTaskId,
    kind: "delegate_task",
    requester: request.requester,
    target: request.target,
    task: {
      intent: request.task.intent,
      summary,
      instructions: request.task.instructions,
      input: request.task.input,
      expectedOutput: request.task.expectedOutput,
    },
    constraints: {
      timeoutSeconds: request.constraints?.timeoutSeconds,
      maxPingPongTurns: request.constraints?.maxPingPongTurns,
      requireFinal: request.constraints?.requireFinal,
      allowAnnounce: request.constraints?.allowAnnounce,
      priority: request.constraints?.priority,
    },
    trace: {
      parentRunId: request.parentRunId ?? request.runtime?.waitRunId,
      correlationId: request.correlationId ?? request.runtime?.waitRunId,
    },
  };
}

export function buildA2ATaskEnvelopeFromExchange(params: {
  request: A2AExchangeRequest;
  taskId?: string;
  correlationId?: string;
}): A2ATaskEnvelopeV1 {
  return buildA2ATaskEnvelopeFromRequest({
    request: buildA2ATaskRequestFromExchange(params),
    taskId: params.taskId,
  });
}

function buildA2AExchangeRequestFromTaskRequest(request: A2ATaskRequest): A2AExchangeRequest {
  const timeoutSeconds = request.constraints?.timeoutSeconds ?? 30;
  return {
    requester: request.requester,
    target: request.target,
    originalMessage: request.task.instructions,
    announceTimeoutMs: request.runtime?.announceTimeoutMs ?? Math.max(1, timeoutSeconds) * 1000,
    maxPingPongTurns:
      request.runtime?.maxPingPongTurns ?? request.constraints?.maxPingPongTurns ?? 0,
    roundOneReply:
      request.runtime?.roundOneReply ??
      (typeof request.task.input?.roundOneReply === "string"
        ? request.task.input.roundOneReply
        : undefined),
    waitRunId: request.runtime?.waitRunId ?? request.parentRunId ?? request.taskId,
  };
}

function createA2ATaskRecordFromRequest(params: {
  request: A2ATaskRequest;
  now?: number;
}): A2ATaskRecord {
  const envelope = buildA2ATaskEnvelopeFromRequest({ request: params.request });
  const now = params.now ?? Date.now();
  const created = createA2ATaskCreatedEvent({ envelope, at: now });
  const accepted = createA2ATaskAcceptedEvent({ taskId: envelope.taskId, at: now });
  return applyA2ATaskEvent(
    applyA2ATaskEvent(createA2ATaskRecord({ envelope, now, deliveryMode: "announce" }), created),
    accepted,
  );
}

export function createA2AExchangeRecord(params: {
  request: A2AExchangeRequest;
  taskId?: string;
  now?: number;
}): A2ATaskRecord {
  return createA2ATaskRecordFromRequest({
    request: buildA2ATaskRequestFromExchange({
      request: params.request,
      taskId: params.taskId ?? params.request.waitRunId,
    }),
    now: params.now,
  });
}

async function applyBrokerEvent(params: {
  record: A2ATaskRecord;
  event: A2ATaskEvent;
  eventSink?: A2ATaskEventSink;
}): Promise<A2ATaskRecord> {
  await params.eventSink?.append(params.event);
  return applyA2ATaskEvent(params.record, params.event);
}

function assertTraceMatchesRecord(params: {
  record: A2ATaskRecord;
  method: "a2a.task.update" | "a2a.task.cancel";
  correlationId?: string;
  parentRunId?: string;
}) {
  const expectedCorrelationId = params.record.envelope.trace?.correlationId;
  const expectedParentRunId = params.record.envelope.trace?.parentRunId;

  if (params.correlationId !== undefined && params.correlationId !== expectedCorrelationId) {
    throw new Error(
      `${params.method} correlationId mismatch for task ${params.record.taskId}: expected ${expectedCorrelationId ?? "<missing>"}, got ${params.correlationId}`,
    );
  }

  if (params.parentRunId !== undefined && params.parentRunId !== expectedParentRunId) {
    throw new Error(
      `${params.method} parentRunId mismatch for task ${params.record.taskId}: expected ${expectedParentRunId ?? "<missing>"}, got ${params.parentRunId}`,
    );
  }
}

async function emitTaskLifecyclePreamble(params: {
  record: A2ATaskRecord;
  eventSink?: A2ATaskEventSink;
}): Promise<A2ATaskRecord> {
  let record = params.record;
  record = await applyBrokerEvent({
    record,
    event: createA2ATaskCreatedEvent({ envelope: record.envelope, at: record.execution.createdAt }),
    eventSink: params.eventSink,
  });
  if (typeof record.execution.acceptedAt === "number") {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskAcceptedEvent({ taskId: record.taskId, at: record.execution.acceptedAt }),
      eventSink: params.eventSink,
    });
  }
  return record;
}

async function runA2AExecutionLifecycle(params: {
  record: A2ATaskRecord;
  request: A2AExchangeRequest;
  runtime: A2ABrokerRuntime;
  eventSink?: A2ATaskEventSink;
  buildReplyContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    currentRole: "requester" | "target";
    turn: number;
    maxTurns: number;
  }) => string;
  buildAnnounceContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    originalMessage: string;
    roundOneReply?: string;
    latestReply?: string;
  }) => string;
  isReplySkip: (text: string) => boolean;
  isAnnounceSkip: (text: string) => boolean;
}): Promise<A2ATaskRecord> {
  const { request, runtime } = params;
  const runContextId = request.waitRunId ?? params.record.taskId;
  let record = params.record;

  try {
    let primaryReply = request.roundOneReply;
    let latestReply = request.roundOneReply;

    if (!primaryReply && request.waitRunId) {
      primaryReply = await runtime.waitForInitialReply({
        waitRunId: request.waitRunId,
        timeoutMs: Math.min(request.announceTimeoutMs, 60_000),
        targetSessionKey: request.target.sessionKey,
      });
      latestReply = primaryReply;
    }

    if (!latestReply) {
      return record;
    }

    record = await applyBrokerEvent({
      record,
      event: createA2AWorkerStartedEvent({ taskId: record.taskId }),
      eventSink: params.eventSink,
    });

    const announceTarget = await runtime.resolveAnnounceTarget({
      targetSessionKey: request.target.sessionKey,
      displayKey: request.target.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    if (
      request.maxPingPongTurns > 0 &&
      request.requester &&
      request.requester.sessionKey !== request.target.sessionKey
    ) {
      let current: A2ATaskRecord["envelope"]["target"] = request.requester;
      let next: A2ATaskRecord["envelope"]["target"] = {
        sessionKey: request.target.sessionKey,
        displayKey: request.target.displayKey,
        channel: targetChannel,
      };
      let incomingMessage = latestReply;

      for (let turn = 1; turn <= request.maxPingPongTurns; turn += 1) {
        const currentRole =
          current.sessionKey === request.requester.sessionKey ? "requester" : "target";
        const replyPrompt = params.buildReplyContext({
          requesterSessionKey: request.requester.sessionKey,
          requesterChannel: request.requester.channel,
          targetSessionKey: request.target.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: request.maxPingPongTurns,
        });
        const replyResult = await runtime.runReplyStep({
          sessionKey: current.sessionKey,
          incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: request.announceTimeoutMs,
          sourceSessionKey: next.sessionKey,
          sourceChannel: next.channel,
        });
        const replyText = replyResult.reply;
        record = await applyBrokerEvent({
          record,
          event: createA2AWorkerHeartbeatEvent({ taskId: record.taskId }),
          eventSink: params.eventSink,
        });
        if (!replyText || params.isReplySkip(replyText)) {
          break;
        }
        record = await applyBrokerEvent({
          record,
          event: createA2AWorkerReplyEvent({ taskId: record.taskId, text: replyText }),
          eventSink: params.eventSink,
        });
        latestReply = replyText;
        incomingMessage = replyText;
        const swap = current;
        current = next;
        next = swap;
      }
    }

    const announcePrompt = params.buildAnnounceContext({
      requesterSessionKey: request.requester?.sessionKey,
      requesterChannel: request.requester?.channel,
      targetSessionKey: request.target.displayKey,
      targetChannel,
      originalMessage: request.originalMessage,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceResult = await runtime.runAnnounceStep({
      sessionKey: request.target.sessionKey,
      extraSystemPrompt: announcePrompt,
      timeoutMs: request.announceTimeoutMs,
      sourceSessionKey: request.requester?.sessionKey,
      sourceChannel: request.requester?.channel,
    });
    const announceReply = announceResult.reply;

    if (
      announceTarget &&
      announceReply &&
      announceReply.trim() &&
      !params.isAnnounceSkip(announceReply)
    ) {
      const publishResult = await runtime.publishAnnouncement({
        target: announceTarget,
        message: announceReply.trim(),
      });
      record = await applyBrokerEvent({
        record,
        event:
          publishResult.status === "sent"
            ? createA2ADeliverySentEvent({ taskId: record.taskId })
            : createA2ADeliveryFailedEvent({
                taskId: record.taskId,
                errorMessage: publishResult.errorMessage,
              }),
        eventSink: params.eventSink,
      });
    } else {
      record = await applyBrokerEvent({
        record,
        event: createA2ADeliverySkippedEvent({ taskId: record.taskId }),
        eventSink: params.eventSink,
      });
    }

    record = await applyBrokerEvent({
      record,
      event: createA2ATaskCompletedEvent({
        taskId: record.taskId,
        summary: announceReply?.trim() || latestReply,
        output: {
          latestReply,
          announceReply,
        },
      }),
      eventSink: params.eventSink,
    });
    return record;
  } catch (err) {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskFailedEvent({
        taskId: record.taskId,
        errorCode: "a2a_request_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
      eventSink: params.eventSink,
    });
    runtime.warn("sessions_send announce flow failed", {
      runId: runContextId,
      taskId: record.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return record;
  }
}

export async function runA2ATaskRequest(params: {
  request: A2ATaskRequest;
  runtime: A2ABrokerRuntime;
  eventSink?: A2ATaskEventSink;
  now?: number;
  buildReplyContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    currentRole: "requester" | "target";
    turn: number;
    maxTurns: number;
  }) => string;
  buildAnnounceContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    originalMessage: string;
    roundOneReply?: string;
    latestReply?: string;
  }) => string;
  isReplySkip: (text: string) => boolean;
  isAnnounceSkip: (text: string) => boolean;
}): Promise<{ record: A2ATaskRecord; response: A2ATaskRequestResult }> {
  const exchangeRequest = buildA2AExchangeRequestFromTaskRequest(params.request);
  let record = createA2ATaskRecordFromRequest({ request: params.request, now: params.now });
  record = await emitTaskLifecyclePreamble({ record, eventSink: params.eventSink });
  record = await runA2AExecutionLifecycle({
    record,
    request: exchangeRequest,
    runtime: params.runtime,
    eventSink: params.eventSink,
    buildReplyContext: params.buildReplyContext,
    buildAnnounceContext: params.buildAnnounceContext,
    isReplySkip: params.isReplySkip,
    isAnnounceSkip: params.isAnnounceSkip,
  });
  return {
    record,
    response: {
      method: "a2a.task.request",
      ...buildA2ATaskProtocolStatus(record),
    },
  };
}

export async function runA2ABrokerExchange(params: {
  request: A2AExchangeRequest;
  taskId?: string;
  runtime: A2ABrokerRuntime;
  eventSink?: A2ATaskEventSink;
  buildReplyContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    currentRole: "requester" | "target";
    turn: number;
    maxTurns: number;
  }) => string;
  buildAnnounceContext: (params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    originalMessage: string;
    roundOneReply?: string;
    latestReply?: string;
  }) => string;
  isReplySkip: (text: string) => boolean;
  isAnnounceSkip: (text: string) => boolean;
}) {
  const result = await runA2ATaskRequest({
    request: buildA2ATaskRequestFromExchange({
      request: params.request,
      taskId: params.taskId ?? params.request.waitRunId,
    }),
    runtime: params.runtime,
    eventSink: params.eventSink,
    buildReplyContext: params.buildReplyContext,
    buildAnnounceContext: params.buildAnnounceContext,
    isReplySkip: params.isReplySkip,
    isAnnounceSkip: params.isAnnounceSkip,
  });
  return result.record;
}

export async function applyA2ATaskProtocolUpdate(params: {
  sessionKey: string;
  update: A2ATaskUpdate;
  eventSink?: A2ATaskEventSink;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskUpdateResult | undefined> {
  const existing = await loadA2ATaskRecordFromEventLog({
    sessionKey: params.sessionKey,
    taskId: params.update.taskId,
    env: params.env,
  });
  if (!existing) {
    return undefined;
  }

  let record = existing;
  assertTraceMatchesRecord({
    record,
    method: "a2a.task.update",
    correlationId: params.update.correlationId,
    parentRunId: params.update.parentRunId,
  });
  const eventSink =
    params.eventSink ??
    createA2ATaskEventLogSink({
      sessionKey: params.sessionKey,
      taskId: params.update.taskId,
      env: params.env,
    });

  if (params.update.heartbeat) {
    record = await applyBrokerEvent({
      record,
      event: createA2AWorkerHeartbeatEvent({ taskId: record.taskId }),
      eventSink,
    });
  }

  if (params.update.executionStatus === "accepted") {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskAcceptedEvent({ taskId: record.taskId }),
      eventSink,
    });
  }

  if (params.update.executionStatus === "running") {
    record = await applyBrokerEvent({
      record,
      event: createA2AWorkerStartedEvent({ taskId: record.taskId }),
      eventSink,
    });
  }

  if (
    params.update.executionStatus === "waiting_reply" ||
    params.update.executionStatus === "waiting_external" ||
    params.update.summary !== undefined ||
    params.update.output !== undefined ||
    params.update.error !== undefined
  ) {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskUpdatedEvent({
        taskId: record.taskId,
        executionStatus:
          params.update.executionStatus === "waiting_reply" ||
          params.update.executionStatus === "waiting_external"
            ? params.update.executionStatus
            : undefined,
        summary: params.update.summary,
        output: params.update.output,
        errorCode: params.update.error?.code,
        errorMessage: params.update.error?.message,
      }),
      eventSink,
    });
  }

  if (params.update.executionStatus === "completed") {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskCompletedEvent({
        taskId: record.taskId,
        summary: params.update.summary,
        output: params.update.output,
      }),
      eventSink,
    });
  }

  if (params.update.executionStatus === "failed") {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskFailedEvent({
        taskId: record.taskId,
        errorCode: params.update.error?.code ?? "failed",
        errorMessage: params.update.error?.message,
      }),
      eventSink,
    });
  }

  if (params.update.executionStatus === "timed_out") {
    record = await applyBrokerEvent({
      record,
      event: createA2ATaskTimedOutEvent({
        taskId: record.taskId,
        errorMessage: params.update.error?.message,
      }),
      eventSink,
    });
  }

  if (params.update.deliveryStatus === "sent") {
    record = await applyBrokerEvent({
      record,
      event: createA2ADeliverySentEvent({ taskId: record.taskId }),
      eventSink,
    });
  }

  if (params.update.deliveryStatus === "skipped") {
    record = await applyBrokerEvent({
      record,
      event: createA2ADeliverySkippedEvent({ taskId: record.taskId }),
      eventSink,
    });
  }

  if (params.update.deliveryStatus === "failed") {
    record = await applyBrokerEvent({
      record,
      event: createA2ADeliveryFailedEvent({
        taskId: record.taskId,
        errorMessage: params.update.deliveryErrorMessage,
      }),
      eventSink,
    });
  }

  return {
    method: "a2a.task.update",
    ...buildA2ATaskProtocolStatus(record),
  };
}

export async function applyA2ATaskProtocolCancel(params: {
  sessionKey: string;
  cancel: A2ATaskCancel;
  runtime?: Pick<A2ABrokerRuntime, "abortTaskRun" | "warn">;
  eventSink?: A2ATaskEventSink;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskCancelResult | undefined> {
  const existing = await loadA2ATaskRecordFromEventLog({
    sessionKey: params.sessionKey,
    taskId: params.cancel.taskId,
    env: params.env,
  });
  if (!existing) {
    return undefined;
  }

  if (["completed", "failed", "cancelled", "timed_out"].includes(existing.execution.status)) {
    return {
      method: "a2a.task.cancel",
      abortStatus: "not-attempted",
      ...buildA2ATaskProtocolStatus(existing),
    };
  }

  let abortStatus: A2ATaskCancelResult["abortStatus"] = "not-attempted";
  assertTraceMatchesRecord({
    record: existing,
    method: "a2a.task.cancel",
    correlationId: params.cancel.correlationId,
    parentRunId: params.cancel.parentRunId,
  });
  const targetSessionKey = params.cancel.targetSessionKey ?? existing.envelope.target.sessionKey;
  const runId = params.cancel.runId ?? existing.envelope.trace?.parentRunId;

  if (params.runtime?.abortTaskRun) {
    const abort = await params.runtime.abortTaskRun({
      sessionKey: targetSessionKey,
      runId,
    });
    abortStatus = abort.status;
    if (abort.status === "error") {
      params.runtime.warn?.("a2a.task.cancel abort failed", {
        taskId: existing.taskId,
        sessionKey: targetSessionKey,
        runId,
        error: abort.errorMessage,
      });
    }
  } else {
    // TODO(openclaw): wire protocol cancellation to every A2A runtime once each caller can
    // surface a stable target session/run pair instead of the current sessions_send-only path.
    params.runtime?.warn?.("a2a.task.cancel abort not wired", {
      taskId: existing.taskId,
      sessionKey: targetSessionKey,
      runId,
    });
  }

  let record = existing;
  const eventSink =
    params.eventSink ??
    createA2ATaskEventLogSink({
      sessionKey: params.sessionKey,
      taskId: params.cancel.taskId,
      env: params.env,
    });
  record = await applyBrokerEvent({
    record,
    event: createA2ATaskCancelledEvent({
      taskId: record.taskId,
      reason: params.cancel.reason,
    }),
    eventSink,
  });

  return {
    method: "a2a.task.cancel",
    abortStatus,
    ...buildA2ATaskProtocolStatus(record),
  };
}

export async function loadA2ATaskProtocolStatusById(params: {
  sessionKey: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<A2ATaskProtocolStatus | undefined> {
  return loadA2ATaskProtocolStatus(params);
}
