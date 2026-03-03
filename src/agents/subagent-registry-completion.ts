import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_OUTCOME_TIMEOUT,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Map a SubagentLifecycleEndedReason to an internal hook action string.
 * This bridges plugin-level lifecycle reasons to the simpler internal hook
 * action vocabulary that user-authored `.js` hooks subscribe to.
 */
function reasonToInternalAction(reason: SubagentLifecycleEndedReason): string {
  switch (reason) {
    case "subagent-complete":
      return "complete";
    case "subagent-error":
      return "error";
    case "subagent-killed":
      return "killed";
    case "session-reset":
      return "reset";
    case "session-delete":
      return "delete";
    default:
      return "complete";
  }
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
    return (a.error ?? "") === (b.error ?? "");
  }
  return true;
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
    // Bridge to internal hook system so user-authored .js hooks can observe
    // subagent lifecycle events without writing a full plugin.
    const internalAction = reasonToInternalAction(params.reason);
    const startedAt = (params.entry as Record<string, unknown>).startedAt as number | undefined;
    void triggerInternalHook(
      createInternalHookEvent("subagent", internalAction, params.entry.requesterSessionKey, {
        childSessionKey: params.entry.childSessionKey,
        runId: params.entry.runId,
        reason: params.reason,
        outcome: params.outcome,
        error: params.error,
        endedAt: params.entry.endedAt,
        startedAt,
        runtimeMs: params.entry.endedAt && startedAt ? params.entry.endedAt - startedAt : undefined,
      }),
    );

    params.entry.endedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch {
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}
