import type { GatewayMessageChannel } from "../../utils/message-channel.js";

export type A2APartyRef = {
  sessionKey: string;
  displayKey: string;
  channel?: string;
};

export type A2ATaskIntent = "delegate" | "ask" | "handoff" | "notify";

export type A2ATaskOutputFormat = "text" | "json";

export type A2AExecutionStatus =
  | "accepted"
  | "running"
  | "waiting_reply"
  | "waiting_external"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type A2ADeliveryStatus = "none" | "pending" | "sent" | "skipped" | "failed";

export type A2ADeliveryMode = "announce" | "reply" | "silent";

export type A2ATaskEnvelopeV1 = {
  v: 1;
  taskId: string;
  kind: "delegate_task";
  requester?: A2APartyRef;
  target: A2APartyRef;
  task: {
    intent: A2ATaskIntent;
    summary: string;
    instructions: string;
    input?: Record<string, unknown>;
    expectedOutput?: {
      format: A2ATaskOutputFormat;
      schemaName?: string;
    };
  };
  constraints?: {
    timeoutSeconds?: number;
    maxPingPongTurns?: number;
    requireFinal?: boolean;
    allowAnnounce?: boolean;
    priority?: "low" | "normal" | "high";
  };
  trace?: {
    parentRunId?: string;
    idempotencyKey?: string;
    correlationId?: string;
  };
  runtime?: {
    cancelTarget?: A2ATaskCancelTarget;
  };
};

export type A2ATaskConstraints = NonNullable<A2ATaskEnvelopeV1["constraints"]>;

export type A2ATaskError = {
  code: string;
  message?: string;
};

export type A2ATaskCancelTarget = {
  kind: "session_run";
  sessionKey: string;
  runId?: string;
};

export type A2ATaskAbortResult = {
  attempted: boolean;
  aborted: boolean;
  status: "aborted" | "no-active-run" | "error";
  errorMessage?: string;
};

export type A2ATaskRecord = {
  taskId: string;
  envelope: A2ATaskEnvelopeV1;
  execution: {
    status: A2AExecutionStatus;
    createdAt: number;
    acceptedAt?: number;
    startedAt?: number;
    heartbeatAt?: number;
    updatedAt?: number;
    completedAt?: number;
    errorCode?: string;
    errorMessage?: string;
  };
  delivery: {
    status: A2ADeliveryStatus;
    mode: A2ADeliveryMode;
    updatedAt?: number;
    errorMessage?: string;
  };
  result?: {
    summary?: string;
    output?: unknown;
  };
};

export type A2ATaskEvent =
  | { type: "task.created"; taskId: string; at: number; envelope: A2ATaskEnvelopeV1 }
  | { type: "task.accepted"; taskId: string; at: number }
  | {
      type: "task.updated";
      taskId: string;
      at: number;
      executionStatus?: Exclude<
        A2AExecutionStatus,
        "completed" | "failed" | "cancelled" | "timed_out"
      >;
      summary?: string;
      output?: unknown;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "worker.started"; taskId: string; at: number }
  | { type: "worker.heartbeat"; taskId: string; at: number }
  | { type: "worker.reply"; taskId: string; at: number; text?: string }
  | { type: "task.completed"; taskId: string; at: number; summary?: string; output?: unknown }
  | {
      type: "task.failed";
      taskId: string;
      at: number;
      errorCode: string;
      errorMessage?: string;
    }
  | { type: "task.cancelled"; taskId: string; at: number; reason?: string }
  | { type: "task.timed_out"; taskId: string; at: number; errorMessage?: string }
  | { type: "delivery.sent"; taskId: string; at: number }
  | { type: "delivery.skipped"; taskId: string; at: number }
  | { type: "delivery.failed"; taskId: string; at: number; errorMessage?: string };

export type A2AExchangeRequest = {
  requester?: A2APartyRef;
  target: A2APartyRef;
  originalMessage: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  roundOneReply?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  cancelTarget?: A2ATaskCancelTarget;
};

export type A2ATaskRequest = {
  method: "a2a.task.request";
  taskId?: string;
  correlationId?: string;
  parentRunId?: string;
  requester?: A2APartyRef;
  target: A2APartyRef;
  task: {
    intent: A2ATaskIntent;
    summary?: string;
    instructions: string;
    input?: Record<string, unknown>;
    expectedOutput?: {
      format: A2ATaskOutputFormat;
      schemaName?: string;
    };
  };
  constraints?: Partial<A2ATaskConstraints>;
  runtime?: {
    announceTimeoutMs?: number;
    maxPingPongTurns?: number;
    roundOneReply?: string;
    waitRunId?: string;
    cancelTarget?: A2ATaskCancelTarget;
  };
};

export type A2ATaskUpdate = {
  method: "a2a.task.update";
  taskId: string;
  correlationId?: string;
  parentRunId?: string;
  at?: number;
  executionStatus?: Exclude<A2AExecutionStatus, "cancelled">;
  summary?: string;
  output?: unknown;
  heartbeat?: boolean;
  error?: A2ATaskError;
  deliveryStatus?: Extract<A2ADeliveryStatus, "sent" | "skipped" | "failed">;
  deliveryErrorMessage?: string;
};

export type A2ATaskCancel = {
  method: "a2a.task.cancel";
  taskId: string;
  correlationId?: string;
  parentRunId?: string;
  at?: number;
  reason?: string;
  runId?: string;
  targetSessionKey?: string;
  cancelTarget?: A2ATaskCancelTarget;
};

export type A2ATaskProtocolStatus = {
  taskId: string;
  correlationId?: string;
  parentRunId?: string;
  requester?: A2APartyRef;
  target: A2APartyRef;
  executionStatus: A2AExecutionStatus;
  deliveryStatus: A2ADeliveryStatus;
  summary?: string;
  output?: unknown;
  error?: A2ATaskError;
  updatedAt: number;
  startedAt?: number;
  heartbeatAt?: number;
  hasHeartbeat: boolean;
};

export type A2ATaskRequestResult = A2ATaskProtocolStatus & {
  method: "a2a.task.request";
};

export type A2ATaskUpdateResult = A2ATaskProtocolStatus & {
  method: "a2a.task.update";
};

export type A2ATaskCancelResult = A2ATaskProtocolStatus & {
  method: "a2a.task.cancel";
  abortStatus?: A2ATaskAbortResult["status"] | "not-attempted";
};

export type A2APublishAnnouncementResult = {
  status: "sent" | "failed";
  errorMessage?: string;
};

export type A2AAnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

export type A2AAgentRunResult = {
  reply?: string;
};

export interface A2ATaskEventSink {
  append(event: A2ATaskEvent): Promise<void> | void;
}

export interface A2ABrokerRuntime {
  waitForInitialReply(params: {
    waitRunId: string;
    timeoutMs: number;
    targetSessionKey: string;
  }): Promise<string | undefined>;
  resolveAnnounceTarget(params: {
    targetSessionKey: string;
    displayKey: string;
  }): Promise<A2AAnnounceTarget | null>;
  runReplyStep(params: {
    sessionKey: string;
    incomingMessage: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    sourceSessionKey?: string;
    sourceChannel?: GatewayMessageChannel | string;
  }): Promise<A2AAgentRunResult>;
  runAnnounceStep(params: {
    sessionKey: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    sourceSessionKey?: string;
    sourceChannel?: GatewayMessageChannel | string;
  }): Promise<A2AAgentRunResult>;
  publishAnnouncement(params: {
    target: A2AAnnounceTarget;
    message: string;
  }): Promise<A2APublishAnnouncementResult>;
  abortTask?(params: { target: A2ATaskCancelTarget }): Promise<A2ATaskAbortResult>;
  abortTaskRun?(params: { sessionKey: string; runId?: string }): Promise<A2ATaskAbortResult>;
  warn(event: string, meta: Record<string, unknown>): void;
}
