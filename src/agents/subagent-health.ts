import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const SUBAGENT_HEALTH_STALE_AFTER_MS =
  process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 60_000;

export type SubagentHealthStatus =
  | "active"
  | "stale"
  | "timed_out"
  | "delivery_pending"
  | "delivery_failed"
  | "cleanup_pending"
  | "orphaned"
  | "cancel_reconciling"
  | "terminal";

export type SubagentHealthNextAction =
  | "none"
  | "recover_orphan"
  | "finalize_timeout"
  | "retry_delivery"
  | "resume_cleanup"
  | "wait_cancel_reconciliation";

export type SubagentHealth = {
  status: SubagentHealthStatus;
  reason?: string;
  retryable: boolean;
  nextAction: SubagentHealthNextAction;
};

export type ClassifySubagentHealthParams = {
  run: SubagentRunRecord;
  task?: TaskRecord;
  now: number;
  staleAfterMs: number;
  deliveryStaleAfterMs?: number;
  cleanupStaleAfterMs?: number;
};

function hasFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function ageMs(now: number, at: unknown): number | undefined {
  return hasFiniteTimestamp(at) ? now - at : undefined;
}

function lastObservedActivityAt(run: SubagentRunRecord, task: TaskRecord | undefined): number {
  return Math.max(
    run.startedAt ?? run.createdAt,
    run.sessionStartedAt ?? run.createdAt,
    task?.lastEventAt ?? task?.startedAt ?? task?.createdAt ?? run.createdAt,
  );
}

function deliveryLastActivityAt(run: SubagentRunRecord): number | undefined {
  return (
    run.delivery?.lastAttemptAt ??
    run.delivery?.enqueuedAt ??
    run.delivery?.createdAt ??
    run.delivery?.deliveredAt ??
    run.delivery?.announcedAt
  );
}

function isTerminalCleanupComplete(run: SubagentRunRecord): boolean {
  return (
    hasFiniteTimestamp(run.endedAt) &&
    hasFiniteTimestamp(run.cleanupCompletedAt) &&
    run.execution?.status === "terminal"
  );
}

export function classifySubagentHealth(params: ClassifySubagentHealthParams): SubagentHealth {
  const { run, task, now } = params;

  if (run.killReconciliation) {
    return {
      status: "cancel_reconciling",
      reason: "subagent cancellation is awaiting reconciliation",
      retryable: true,
      nextAction: "wait_cancel_reconciliation",
    };
  }

  if (isTerminalCleanupComplete(run)) {
    return {
      status: "terminal",
      retryable: false,
      nextAction: "none",
    };
  }

  const deadlineMs = resolveSubagentRunDeadlineMs(run, task?.startedAt);
  if (!hasFiniteTimestamp(run.endedAt) && deadlineMs !== undefined && now >= deadlineMs) {
    return {
      status: "timed_out",
      reason: "subagent run exceeded its configured timeout",
      retryable: true,
      nextAction: "finalize_timeout",
    };
  }

  const deliveryStatus = run.delivery?.status;
  if (deliveryStatus === "failed" || deliveryStatus === "suspended") {
    return {
      status: "delivery_failed",
      reason: run.delivery?.lastError ?? "subagent completion delivery failed",
      retryable: deliveryStatus === "failed",
      nextAction: deliveryStatus === "failed" ? "retry_delivery" : "none",
    };
  }

  if (deliveryStatus === "pending" || deliveryStatus === "in_progress") {
    const staleAfterMs = params.deliveryStaleAfterMs ?? params.staleAfterMs;
    const lastDeliveryActivityAgeMs = ageMs(now, deliveryLastActivityAt(run));
    if (lastDeliveryActivityAgeMs === undefined || lastDeliveryActivityAgeMs >= staleAfterMs) {
      return {
        status: "delivery_pending",
        reason: "subagent completion delivery has not settled",
        retryable: true,
        nextAction: "retry_delivery",
      };
    }
    return {
      status: "delivery_pending",
      retryable: false,
      nextAction: "none",
    };
  }

  if (hasFiniteTimestamp(run.endedAt) && !hasFiniteTimestamp(run.cleanupCompletedAt)) {
    const staleAfterMs = params.cleanupStaleAfterMs ?? params.staleAfterMs;
    const cleanupAgeMs = ageMs(now, run.endedAt);
    if (cleanupAgeMs === undefined || cleanupAgeMs >= staleAfterMs) {
      return {
        status: "cleanup_pending",
        reason: "subagent cleanup has not completed",
        retryable: true,
        nextAction: "resume_cleanup",
      };
    }
    return {
      status: "cleanup_pending",
      retryable: false,
      nextAction: "none",
    };
  }

  if (!task) {
    return {
      status: "orphaned",
      reason: "subagent has no task projection",
      retryable: true,
      nextAction: "recover_orphan",
    };
  }

  const activeAgeMs = ageMs(now, lastObservedActivityAt(run, task));
  if (activeAgeMs !== undefined && activeAgeMs >= params.staleAfterMs) {
    return {
      status: "stale",
      reason: "no subagent activity observed within the stale window",
      retryable: true,
      nextAction: "recover_orphan",
    };
  }

  return {
    status: "active",
    retryable: false,
    nextAction: "none",
  };
}
