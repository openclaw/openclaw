/**
 * Explicit contract mapping between OpenClaw A2A protocol types
 * (src/agents/a2a/types.ts) and standalone broker domain types
 * (a2a-broker/src/core/types.ts, as consumed via standalone-broker-client).
 *
 * All broker↔OpenClaw status, error, and trace conversions funnel through
 * these helpers.  If a drift is introduced on either side, this file is the
 * single place to audit.
 */

import { isTerminalExecutionStatus as _isTerminalExecutionStatus } from "./status.js";
import type { A2AExecutionStatus } from "./types.js";
import type { A2ATaskCancelTarget } from "./types.js";
import type { A2ATaskError } from "./types.js";

// ---------------------------------------------------------------------------
// Broker status values (from A2ABrokerTaskStatusSchema / TaskStatus)
// ---------------------------------------------------------------------------

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

/** Broker statuses that are terminal — no further state transitions. */
export const TERMINAL_BROKER_STATUSES: ReadonlySet<BrokerTaskStatus> = new Set([
  "succeeded",
  "failed",
  "canceled",
]);

// ---------------------------------------------------------------------------
// OpenClaw execution status (from A2AExecutionStatus)
// ---------------------------------------------------------------------------

/** OpenClaw statuses that are terminal. */
export const TERMINAL_OPENCLAW_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Non-cancel terminal statuses (used in update path). */
export const NON_CANCEL_TERMINAL_STATUSES: ReadonlySet<A2AExecutionStatus> = new Set([
  "completed",
  "failed",
  "timed_out",
]);

// ---------------------------------------------------------------------------
// Broker → OpenClaw status mapping
// ---------------------------------------------------------------------------

/**
 * Maps a broker TaskStatus to the corresponding OpenClaw A2AExecutionStatus.
 *
 * Broker uses American spelling "canceled"; OpenClaw uses British "cancelled".
 * This is the single source of truth for that translation.
 *
 * "queued"/"claimed" both map to "accepted" (broker has no "accepted" state).
 * "succeeded" maps to "completed".
 * "failed" may map to "timed_out" if the broker error indicates a timeout.
 */
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

/**
 * Maps a broker TaskStatus to the corresponding OpenClaw A2ADeliveryStatus.
 *
 * Terminal broker statuses all map to "skipped" (delivery was handled by
 * the broker, not by OpenClaw announce flow).
 */
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

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps a broker TaskError to OpenClaw A2ATaskError format.
 *
 * Drift points:
 * - Broker: `code?` (optional), `message` (required)
 * - OpenClaw: `code` (required), `message?` (optional)
 *
 * When broker has no code, falls back to `remote_task_failed`.
 * When broker has no message, omits it (OpenClaw field is optional).
 */
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

/**
 * Error codes from the broker that should be treated as timeout conditions.
 */
const BROKER_TIMEOUT_CODES = new Set(["timeout", "timed_out", "broker_timeout"]);

export function isBrokerTimeoutCode(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return BROKER_TIMEOUT_CODES.has(code.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Trace field resolution
// ---------------------------------------------------------------------------

/**
 * Resolves trace fields (correlationId, parentRunId) with explicit priority.
 *
 * Priority order:
 *  1. Explicitly provided value
 *  2. Payload value (from broker task record)
 *  3. Exchange request value
 *  4. TaskId as last resort
 *
 * This prevents silent fallback overwrites — explicit values always win.
 */
export function resolveTraceField(params: {
  explicit?: string | undefined;
  payload?: string | undefined;
  request?: string | undefined;
  fallback?: string | undefined;
}): string | undefined {
  return params.explicit ?? params.payload ?? params.request ?? params.fallback;
}

/**
 * Resolves cancelTarget with explicit priority.
 *
 * Priority order:
 *  1. Explicitly provided cancelTarget
 *  2. Payload cancelTarget (from broker task record)
 *  3. Exchange request cancelTarget
 *  4. Auto-derived from target session + runId
 *  5. undefined (no target)
 */
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
  // Auto-derive only when we have a meaningful sessionKey
  if (params.targetSessionKey) {
    return {
      kind: "session_run",
      sessionKey: params.targetSessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Parses an ISO date string to epoch milliseconds.
 * Returns Date.now() if the input is undefined or unparseable.
 */
export function toEpochMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export function isBrokerTaskTerminal(status: BrokerTaskStatus): boolean {
  return TERMINAL_BROKER_STATUSES.has(status);
}

export { _isTerminalExecutionStatus as isTerminalExecutionStatus };
