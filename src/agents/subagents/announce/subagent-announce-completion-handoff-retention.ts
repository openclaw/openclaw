/**
 * Retained Gateway completion-handoff ownership for announce retries.
 *
 * When an announce gets a nonterminal gateway response (accepted / in_flight),
 * keep the idempotency key so a later retry rejoins that handoff instead of
 * steering into a successor requester run after the original handle settles.
 *
 * Retention is bound to the announce lifecycle: keep across retryable attempts,
 * release on terminal retirement (success, abandonment, permanent failure,
 * deadline expiry / give-up, intentional non-delivery) and when a
 * requester-settle batch retires without another delivery attempt.
 */
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
  buildRequesterSettleAnnounceId,
} from "../../announce-idempotency.js";
import { isActiveEmbeddedRunId } from "../../embedded-agent-runner/runs.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const retainedCompletionHandoffKeys = new Set<string>();

function normalizeCompletionHandoffKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  return normalized || undefined;
}

function retainCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.add(normalized);
  }
}

export function releaseCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.delete(normalized);
  }
}

/** Release retained ownership when announce delivery finally retires a child run. */
export function releaseAnnounceCompletionHandoffForChildRun(params: {
  childSessionKey: string;
  childRunId: string;
}): void {
  releaseCompletionHandoffKey(
    buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: params.childRunId,
      }),
    ),
  );
}

/** Attempt suffixes a settle wake may have retained (base + retry-1/2). */
const REQUESTER_SETTLE_ATTEMPT_KEY_COUNT = 3;

/** Release retained ownership for every attempt key a settle batch may have used. */
export function releaseAnnounceCompletionHandoffForRequesterSettleBatch(params: {
  requesterAgentId?: string;
  requesterSessionKey: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
}): void {
  if (params.batchRunIds.length === 0) {
    return;
  }
  for (let attemptIndex = 0; attemptIndex < REQUESTER_SETTLE_ATTEMPT_KEY_COUNT; attemptIndex += 1) {
    releaseCompletionHandoffKey(
      buildAnnounceIdempotencyKey(
        buildRequesterSettleAnnounceId({
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
          batchRunIds: params.batchRunIds,
          rearmGeneration: params.rearmGeneration,
          attemptIndex,
        }),
      ),
    );
  }
}

/**
 * Keep ownership across retryable attempts; release on every terminal outcome.
 * While ownership remains, mark retryable results terminal so dispatch cannot
 * steer-fallback into a successor requester after an original-handoff replay
 * failure (catch returns retryable without terminal).
 */
export function settleCompletionHandoffRetention(
  key: string | undefined,
  result: SubagentAnnounceDeliveryResult,
): SubagentAnnounceDeliveryResult {
  if (result.disposition !== "retryable") {
    releaseCompletionHandoffKey(key);
    return result;
  }
  if (!result.terminal && shouldJoinOriginalCompletionHandoff(key)) {
    return { ...result, terminal: true };
  }
  return result;
}

export function clearRetainedCompletionHandoffKeysForTest(): void {
  retainedCompletionHandoffKeys.clear();
}

function shouldJoinOriginalCompletionHandoff(key: string | undefined): boolean {
  const normalized = normalizeCompletionHandoffKey(key);
  if (!normalized) {
    return false;
  }
  // Prefer Gateway replay whenever we already own a pending handoff for this
  // key, or the original run is still the active embedded handle.
  return retainedCompletionHandoffKeys.has(normalized) || isActiveEmbeddedRunId(normalized);
}

/** Prefer same-key Gateway replay over steering into an active requester run. */
export function shouldPreferOriginalCompletionHandoff(params: {
  directIdempotencyKey?: string;
  requesterRunId?: string;
}): boolean {
  const pendingHandoffRunId = normalizeCompletionHandoffKey(params.directIdempotencyKey);
  return Boolean(
    pendingHandoffRunId &&
    (params.requesterRunId === pendingHandoffRunId ||
      shouldJoinOriginalCompletionHandoff(pendingHandoffRunId)),
  );
}

/**
 * Map a nonterminal Gateway agent response into announce delivery custody.
 * Public completion announces stay undelivered and retain the handoff key.
 */
export function resolvePendingGatewayCompletionHandoff(params: {
  parentOnly: boolean;
  expectsCompletionMessage?: boolean;
  directIdempotencyKey?: string;
}): SubagentAnnounceDeliveryResult {
  if (params.parentOnly) {
    retainCompletionHandoffKey(params.directIdempotencyKey);
    return {
      delivered: false,
      path: "direct",
      reason: "requester_turn_pending",
      disposition: "retryable",
    };
  }
  if (params.expectsCompletionMessage) {
    retainCompletionHandoffKey(params.directIdempotencyKey);
    return {
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    };
  }
  return { delivered: true, path: "direct" };
}

/** Block :text-direct fallback while a retained original handoff may still settle. */
export function resolveTextDirectBlockedByRetainedHandoff(params: {
  directIdempotencyKey?: string;
  error?: string;
}): SubagentAnnounceDeliveryResult | undefined {
  if (
    !shouldPreferOriginalCompletionHandoff({
      directIdempotencyKey: params.directIdempotencyKey,
    })
  ) {
    return undefined;
  }
  return {
    delivered: false,
    path: "direct",
    reason: "completion_handoff_pending",
    ...(params.error ? { error: params.error } : {}),
    disposition: "retryable",
    terminal: true,
  };
}
