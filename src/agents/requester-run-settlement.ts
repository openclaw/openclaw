import { getActiveAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  hasCompletionMessageSessionSpawn,
  mergeAcceptedSessionSpawnsForRun,
} from "./accepted-session-spawn.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { recordModelFallbackStop } from "./failover-error.js";
import { createSessionPlacementSettlementClosedAbortError } from "./run-termination.js";
import {
  markRequesterTurnYielded,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.js";

// A fallback stop can also mean unrelated CLI cleanup failed. Only our failed
// registry commit must suppress a second requester-settlement attempt.
const settlementFailures = resolveGlobalSingleton(
  Symbol.for("openclaw.requesterSettlementFailures"),
  () => new WeakSet<object>(),
);
type RequesterRunParams = Pick<
  RunEmbeddedAgentParams,
  "sessionKey" | "agentId" | "runId" | "abortSignal" | "admittedRunContext" | "preparedRunAdmission"
>;

/** Failure cleanup belongs to the whole fallback chain, while its admission is still live. */
export function settleFailedRequesterRun(
  params: RequesterRunParams,
  error: unknown,
  assertCurrent?: () => void,
): unknown {
  const instance =
    params.admittedRunContext?.operationalRunInstance ??
    params.preparedRunAdmission?.operationalRunInstance;
  if (
    !instance ||
    params.abortSignal?.aborted ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && settlementFailures.has(error)) ||
    getActiveAgentRunDelegatedAuthority(instance)?.operationalRunInstance !== instance
  ) {
    return error;
  }
  // Authority loss is an intentional non-action. Required persistence failure
  // remains part of the terminal error alongside the original run failure.
  try {
    assertCurrent?.();
  } catch {
    return error;
  }
  if (
    params.abortSignal?.aborted ||
    getActiveAgentRunDelegatedAuthority(instance)?.operationalRunInstance !== instance
  ) {
    return error;
  }
  try {
    settleRequesterRun(params, { meta: { durationMs: 0 } }, () => {});
  } catch (settlementError) {
    const failure = new AggregateError(
      [error, settlementError],
      "Agent run failed and requester child settlement failed",
      { cause: error },
    );
    settlementFailures.add(failure);
    recordModelFallbackStop(failure);
    return failure;
  }
  return error;
}

/** Transfers the complete logical run's children only after retries have finished. */
export function settleRequesterRun(
  params: RequesterRunParams,
  result: EmbeddedAgentRunResult,
  assertCurrent: () => void,
): void {
  const instance =
    params.admittedRunContext?.operationalRunInstance ??
    params.preparedRunAdmission?.operationalRunInstance;
  if (instance) {
    const accepted = mergeAcceptedSessionSpawnsForRun(instance, result.acceptedSessionSpawns);
    if (accepted.length > 0) {
      result.acceptedSessionSpawns = accepted;
    }
  }
  if (
    !params.sessionKey ||
    !hasCompletionMessageSessionSpawn(result.acceptedSessionSpawns) ||
    params.abortSignal?.aborted ||
    result.meta.aborted ||
    result.requesterContinuationSettled === true
  ) {
    return;
  }
  const requester = {
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    requesterTurnRunId: params.runId,
  };
  assertCurrent();
  params.abortSignal?.throwIfAborted();
  if (
    instance &&
    getActiveAgentRunDelegatedAuthority(instance)?.operationalRunInstance !== instance
  ) {
    throw createSessionPlacementSettlementClosedAbortError();
  }
  try {
    if (result.meta.continuationPending) {
      // The outbox transfers this batch only after its waiting status is delivered.
      if (markRequesterTurnYielded(requester) === 0) {
        throw new Error("accepted continuation children were not durably registered");
      }
      return;
    }
    const settled = settleRequesterAfterSessionSpawns({
      ...requester,
      requesterYielded: result.meta.yielded === true,
      acceptedSessionSpawns: result.acceptedSessionSpawns ?? [],
    });
    if (result.meta.yielded) {
      if (!settled) {
        throw new Error("accepted continuation children could not transfer terminal delivery");
      }
      result.requesterContinuationSettled = true;
    }
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      settlementFailures.add(error);
    }
    if (error instanceof Error) {
      recordModelFallbackStop(error);
    }
    throw error;
  }
}
