import { isTerminalSessionStatus } from "../../../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import { loadSessionEntryByKey } from "../announce/subagent-announce-delivery.runtime.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { resolveSubagentYieldWaitSource } from "./subagent-registry-read.js";
import { resolveYieldedRunContinuation } from "./subagent-registry-run-pause.js";
import type { createSubagentSweepReadScope } from "./subagent-registry-sweep-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { isYieldedSubagentRun } from "./subagent-run-liveness.js";

type CompleteRun = ReturnType<
  typeof createSubagentRegistryCompletionRuntime
>["completeSubagentRunWithRecovery"];
type SweepReadScope = ReturnType<typeof createSubagentSweepReadScope>;

/**
 * Settles a yielded run that no continuation can reach (see
 * `resolveYieldedRunContinuation`) through the completion owner. Returns whether it did.
 */
export async function settleUnreachableYieldedSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  readScope?: Pick<SweepReadScope, "completionCurrent">;
  complete: CompleteRun;
  requesterEnded?: boolean;
}): Promise<boolean> {
  const { runId, entry, readScope, complete } = params;
  let requesterEnded = params.requesterEnded;
  if (isYieldedSubagentRun(entry) && entry.waitForMessage && requesterEnded === undefined) {
    const requester = await loadSessionEntryByKey(
      entry.requesterSessionKey,
      entry.requesterAgentId,
    );
    requesterEnded =
      !requester || requester.archivedAt !== undefined || isTerminalSessionStatus(requester.status);
  }
  const retired = subagentRuns.isCompletionAuthorityRetired(entry);
  let continuation = isYieldedSubagentRun(entry)
    ? resolveYieldedRunContinuation(entry, requesterEnded)
    : undefined;
  if (
    continuation?.state === "continuable" &&
    retired &&
    !entry.collect &&
    !resolveSubagentYieldWaitSource(entry)
  ) {
    continuation = {
      state: "unreachable",
      error: "Descendant completion can no longer continue this yielded requester.",
    };
  }
  if (continuation?.state !== "unreachable") {
    return false;
  }
  // An outcome the yield already recorded is kept, as a collector that yields now ends with its
  // yielded turn as its result; only a run with no recorded outcome takes the diagnostic error.
  const outcome = entry.execution.outcome ?? {
    status: "error" as const,
    error: continuation.error,
  };
  await complete(
    {
      runId,
      expectedEntry: entry,
      recoveryCurrent: readScope?.completionCurrent,
      // The run ended when it yielded; settling now must not rewrite that time.
      endedAt: entry.execution.endedAt,
      outcome,
      reason:
        outcome.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
      settleYielded: true,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    "sweeper-unreachable-yield",
  );
  // A restored task has no old delivery authority. Close only its exact parked
  // lifecycle through the system projection; never revive its execution or tools.
  if (retired) {
    const authority = resolveSubagentChildAuthority(entry);
    const settled = subagentRuns.get(runId);
    if (
      authority.status === "verified" &&
      isSameSubagentRunOwner(settled, entry) &&
      settled?.endedReason === SUBAGENT_ENDED_REASON_ERROR
    ) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: entry.childSessionKey,
        agentId: authority.childAgentId,
        expectedWriter: { ...authority.sessionIdentity, runId, requireYielded: true },
        event: {
          runId,
          sessionId: authority.sessionIdentity.sessionId,
          ts: Date.now(),
          data: { phase: "error", error: outcome.status === "error" ? outcome.error : undefined },
        },
      });
    }
  }
  return true;
}
