import { createHash } from "node:crypto";
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

/**
 * Build privacy-minimal metadata for the exact frozen child final string.
 *
 * Blank/whitespace-only finals are omitted, but non-blank values are not
 * trimmed or otherwise canonicalized before hashing. `textSha256` is SHA-256
 * over the exact UTF-8 bytes of `entry.frozenResultText`, and `byteLength` is
 * that same UTF-8 byte count.
 */
export function buildSubagentEndedFinalMetadata(entry: SubagentRunRecord) {
  const text = typeof entry.frozenResultText === "string" ? entry.frozenResultText : undefined;
  if (!text?.trim()) {
    return undefined;
  }
  return {
    frozenResultTextAvailable: true as const,
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    byteLength: Buffer.byteLength(text, "utf8"),
    ...(entry.frozenResultCapturedAt === undefined
      ? {}
      : { capturedAt: entry.frozenResultCapturedAt }),
  };
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
          final: buildSubagentEndedFinalMetadata(params.entry),
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
