/**
 * Explicit contract mapping between OpenClaw A2A protocol status/error shapes
 * and standalone broker domain types.
 *
 * The plugin owns broker-specific status translation so core callers can depend
 * on the bundled public seam instead of a core-local helper.
 */

export type A2AExecutionStatus =
  | "accepted"
  | "running"
  | "waiting_reply"
  | "waiting_external"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type A2ATaskError = {
  code: string;
  message?: string;
};

export type A2ATaskCancelTarget = {
  kind: "session_run";
  sessionKey: string;
  runId?: string;
};

/** Every broker task status literal. */
export type BrokerTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** Broker statuses that indicate the task is still in-flight. */
export const ACTIVE_BROKER_STATUSES: ReadonlySet<BrokerTaskStatus> = new Set([
  "queued",
  "claimed",
  "running",
]);

/** Broker statuses that are terminal, no further state transitions. */
export const TERMINAL_BROKER_STATUSES: ReadonlySet<BrokerTaskStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

/** OpenClaw statuses that are terminal. */
export const TERMINAL_OPENCLAW_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Non-cancel terminal statuses. */
export const NON_CANCEL_TERMINAL_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
]);

export function mapBrokerStatusToExecutionStatus(params: {
  brokerStatus: BrokerTaskStatus;
  brokerErrorCode?: string | undefined;
}): Exclude<A2AExecutionStatus, "cancelled"> {
  switch (params.brokerStatus) {
    case "queued":
    case "claimed":
      return "accepted";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
      return isBrokerTimeoutCode(params.brokerErrorCode) ? "timed_out" : "failed";
    default:
      return "failed";
  }
}

export function mapBrokerStatusToDeliveryStatus(
  brokerStatus: BrokerTaskStatus,
): "none" | "pending" | "sent" | "skipped" | "failed" {
  switch (brokerStatus) {
    case "queued":
    case "claimed":
    case "running":
      return "pending";
    case "succeeded":
    case "failed":
    case "canceled":
      return "skipped";
    default:
      return "pending";
  }
}

export function mapBrokerErrorToTaskError(params: {
  brokerErrorCode?: string | undefined;
  brokerErrorMessage?: string | undefined;
  brokerStatus?: BrokerTaskStatus;
}): A2ATaskError | undefined {
  const code =
    params.brokerErrorCode ?? (params.brokerStatus === "failed" ? "remote_task_failed" : undefined);
  if (!code) {
    return undefined;
  }
  return {
    code,
    ...(params.brokerErrorMessage ? { message: params.brokerErrorMessage } : {}),
  };
}

const BROKER_TIMEOUT_CODES = new Set(["timeout", "timed_out", "broker_timeout"]);

export function isBrokerTimeoutCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return BROKER_TIMEOUT_CODES.has(code.trim().toLowerCase());
}

export function resolveTraceField(params: {
  explicit?: string | undefined;
  payload?: string | undefined;
  request?: string | undefined;
  fallback?: string | undefined;
}): string | undefined {
  return params.explicit ?? params.payload ?? params.request ?? params.fallback;
}

export function resolveCancelTarget(params: {
  explicit?: A2ATaskCancelTarget | undefined;
  payload?: A2ATaskCancelTarget | undefined;
  request?: A2ATaskCancelTarget | undefined;
  targetSessionKey?: string | undefined;
  runId?: string | undefined;
}): A2ATaskCancelTarget | undefined {
  const target = params.explicit ?? params.payload ?? params.request;
  if (target) {
    return target;
  }
  if (params.targetSessionKey) {
    return {
      kind: "session_run",
      sessionKey: params.targetSessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
    };
  }
  return undefined;
}

export function toEpochMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function isBrokerTaskTerminal(status: BrokerTaskStatus): boolean {
  return TERMINAL_BROKER_STATUSES.has(status);
}

export function isTerminalExecutionStatus(status: string | undefined): boolean {
  return TERMINAL_OPENCLAW_STATUSES.has(status as A2AExecutionStatus);
}
