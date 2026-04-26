import { emitContinuityDiagnostic } from "../infra/continuity-diagnostics.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_OUTCOME_TIMEOUT,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function sameShallowRecord(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  if (!a) {
    return false;
  }
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function runOutcomesEqual(
  a: SubagentRunOutcome | undefined,
  b: SubagentRunOutcome | undefined,
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === "error" && b.status === "error") {
    if ((a.error ?? "") !== (b.error ?? "")) {
      return false;
    }
  }
  if (!runOutcomeHasTiming(a) || !runOutcomeHasTiming(b)) {
    return true;
  }
  return a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.elapsedMs === b.elapsedMs;
}

export function runOutcomeHasTiming(outcome: SubagentRunOutcome | undefined): boolean {
  return (
    Number.isFinite(outcome?.startedAt) ||
    Number.isFinite(outcome?.endedAt) ||
    Number.isFinite(outcome?.elapsedMs)
  );
}

export function shouldUpdateRunOutcome(
  current: SubagentRunOutcome | undefined,
  next: SubagentRunOutcome | undefined,
): boolean {
  return (
    !runOutcomesEqual(current, next) || (!runOutcomeHasTiming(current) && runOutcomeHasTiming(next))
  );
}

export function resolveLifecycleOutcomeFromRunOutcome(
  outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
  if (outcome?.status === "error") {
    return SUBAGENT_ENDED_OUTCOME_ERROR;
  }
  if (outcome?.status === "timeout") {
    return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
  }
  return SUBAGENT_ENDED_OUTCOME_OK;
}

export function recordSubagentTerminalState(
  entry: SubagentRunRecord,
  params: {
    reason: SubagentLifecycleEndedReason;
    outcome?: SubagentRunOutcome;
    endedAt?: number;
  },
): boolean {
  const outcome = params.outcome ?? { status: "unknown" };
  const next = {
    type: "subagent.child.terminal_state" as const,
    status: typeof outcome.status === "string" ? outcome.status : "unknown",
    reason: params.reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    startedAt: typeof outcome.startedAt === "number" ? outcome.startedAt : entry.startedAt,
    endedAt: params.endedAt,
    elapsedMs: typeof outcome.elapsedMs === "number" ? outcome.elapsedMs : undefined,
    error: typeof outcome.error === "string" ? outcome.error : undefined,
    recordedAt: Date.now(),
  };
  const comparableKeys = ["status", "reason", "startedAt", "endedAt", "elapsedMs", "error"];
  if (sameShallowRecord(entry.childTerminalState, next, comparableKeys)) {
    return false;
  }
  const previous = entry.childTerminalState;
  entry.childTerminalState = next;
  emitContinuityDiagnostic({
    type: "diag.subagent.child_terminal_state",
    severity: next.status === "error" || next.status === "timeout" ? "warn" : "info",
    sessionKey: entry.childSessionKey,
    runId: entry.runId,
    phase: "subagent_terminal",
    correlation: {
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
    },
    details: {
      terminalState: next,
      previousStatus: previous?.status,
      previousReason: previous?.reason,
    },
  });
  return true;
}

export function recordSubagentAnnounceOutcome(
  entry: SubagentRunRecord,
  params: {
    status: "delivered" | "deferred" | "failed" | "skipped";
    reason: string;
    delivered: boolean;
    cleanup: "delete" | "keep";
    nextDelayMs?: number;
  },
): boolean {
  const next = {
    type: "subagent.announce_outcome" as const,
    status: params.status,
    reason: params.reason,
    delivered: params.delivered,
    cleanup: params.cleanup,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    completionAnnouncedAt: entry.completionAnnouncedAt,
    retryCount: entry.announceRetryCount,
    nextDelayMs: params.nextDelayMs,
    recordedAt: Date.now(),
  };
  const comparableKeys = [
    "status",
    "reason",
    "delivered",
    "cleanup",
    "completionAnnouncedAt",
    "retryCount",
    "nextDelayMs",
  ];
  if (sameShallowRecord(entry.announceOutcome, next, comparableKeys)) {
    return false;
  }
  const previous = entry.announceOutcome;
  entry.announceOutcome = next;
  emitContinuityDiagnostic({
    type: "diag.subagent.announce_outcome",
    severity: params.status === "failed" ? "warn" : "info",
    sessionKey: entry.childSessionKey,
    runId: entry.runId,
    phase: "subagent_announce",
    correlation: {
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
    },
    details: {
      announceOutcome: next,
      previousStatus: previous?.status,
      previousReason: previous?.reason,
    },
  });
  return true;
}

export async function emitSubagentEndedHookOnce(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  outcome?: SubagentLifecycleEndedOutcome;
  error?: string;
  inFlightRunIds: Set<string>;
  persist: () => void;
}) {
  const runId = params.entry.runId.trim();
  if (!runId) {
    return false;
  }
  if (params.entry.endedHookEmittedAt) {
    return false;
  }
  if (params.inFlightRunIds.has(runId)) {
    return false;
  }

  params.inFlightRunIds.add(runId);
  try {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner) {
      return false;
    }
    if (hookRunner?.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(
        {
          targetSessionKey: params.entry.childSessionKey,
          targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
          reason: params.reason,
          sendFarewell: params.sendFarewell,
          accountId: params.accountId,
          runId: params.entry.runId,
          endedAt: params.entry.endedAt,
          outcome: params.outcome,
          error: params.error,
        },
        {
          runId: params.entry.runId,
          childSessionKey: params.entry.childSessionKey,
          requesterSessionKey: params.entry.requesterSessionKey,
        },
      );
    }
    params.entry.endedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch {
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}
