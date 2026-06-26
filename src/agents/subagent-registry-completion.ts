import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
/**
 * Subagent run completion helpers.
 * Compares outcomes, maps them to lifecycle events, and emits completion hooks
 * exactly once per completed child run.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
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

const log = createSubsystemLogger("agents/subagent-registry-completion");

/** Compares subagent run outcomes, treating missing timing as compatible. */
function runOutcomesEqual(
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

/** Returns true when an outcome carries timing fields. */
function runOutcomeHasTiming(outcome: SubagentRunOutcome | undefined): boolean {
  return (
    Number.isFinite(outcome?.startedAt) ||
    Number.isFinite(outcome?.endedAt) ||
    Number.isFinite(outcome?.elapsedMs)
  );
}

/** Returns true when a run outcome update should replace current state. */
export function shouldUpdateRunOutcome(
  current: SubagentRunOutcome | undefined,
  next: SubagentRunOutcome | undefined,
): boolean {
  return (
    !runOutcomesEqual(current, next) || (!runOutcomeHasTiming(current) && runOutcomeHasTiming(next))
  );
}

/** Clears progress-cleanup hook state before replacing a completed outcome. */
export function resetSubagentRunProgressEndedHookMarker(entry: SubagentRunRecord): void {
  entry.progressEndedHookEmittedAt = undefined;
}

/** Maps registry run outcome to lifecycle event outcome. */
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

type SubagentCompletionHookParams = {
  entry: SubagentRunRecord;
  config?: OpenClawConfig;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  outcome?: SubagentLifecycleEndedOutcome;
  error?: string;
  inFlightRunIds: Set<string>;
  persist: () => void;
};

function createSubagentEndedHookEvent(params: SubagentCompletionHookParams) {
  return {
    targetSessionKey: params.entry.childSessionKey,
    targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
    reason: params.reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId,
    runId: params.entry.runId,
    endedAt: params.entry.endedAt,
    requester: {
      channel: params.entry.requesterOrigin?.channel,
      accountId: params.entry.requesterOrigin?.accountId,
      to: params.entry.requesterOrigin?.to,
      threadId: params.entry.requesterOrigin?.threadId,
      messageId: params.entry.requesterOrigin?.messageId,
    },
    outcome: params.outcome,
    error: params.error,
  };
}

type SubagentProgressChannelPlugin = {
  subagentProgress?: {
    handleEnded?: (params: {
      config: OpenClawConfig;
      event: ReturnType<typeof createSubagentEndedHookEvent>;
    }) => Promise<boolean | void> | boolean | void;
  };
};

/** Emits the internal subagent progress-ended event once per completed run. */
export async function emitSubagentProgressEndedHookOnce(params: SubagentCompletionHookParams) {
  const runId = params.entry.runId.trim();
  if (!runId) {
    return false;
  }
  if (params.entry.progressEndedHookEmittedAt) {
    return false;
  }
  if (params.inFlightRunIds.has(runId)) {
    return false;
  }

  // In-flight guard prevents concurrent completion paths from double-emitting
  // the hook before progressEndedHookEmittedAt is persisted.
  params.inFlightRunIds.add(runId);
  try {
    const event = createSubagentEndedHookEvent(params);
    const channel = params.entry.requesterOrigin?.channel;
    const plugin = channel
      ? (getChannelPlugin(channel) as SubagentProgressChannelPlugin | undefined)
      : undefined;
    if (params.config && plugin?.subagentProgress?.handleEnded) {
      const handled = await plugin.subagentProgress.handleEnded({
        config: params.config,
        event,
      });
      if (handled === false) {
        return false;
      }
    }
    params.entry.progressEndedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch (err) {
    log.warn(
      `failed to emit subagent progress-ended cleanup for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}

/** Emits the subagent_ended hook once per completed run. */
export async function emitSubagentEndedHookOnce(params: SubagentCompletionHookParams) {
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

  // In-flight guard prevents concurrent completion paths from double-emitting
  // the hook before endedHookEmittedAt is persisted.
  params.inFlightRunIds.add(runId);
  try {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner) {
      return false;
    }
    if (hookRunner?.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(createSubagentEndedHookEvent(params), {
        runId: params.entry.runId,
        childSessionKey: params.entry.childSessionKey,
        requesterSessionKey: params.entry.requesterSessionKey,
      });
    }
    params.entry.endedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch (err) {
    log.warn(
      `failed to emit subagent_ended hook for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}
