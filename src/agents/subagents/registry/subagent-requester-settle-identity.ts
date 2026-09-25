import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function buildRequesterSettleWakeIdentity(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  attemptIndex?: number;
  /**
   * Private turns reuse one key across attempts: a retry must not republish
   * private input under a new identity. Deliverable turns suffix each retry so a
   * cached terminal failure cannot replay in place of a new delivery attempt.
   */
  sharedAttemptKey?: boolean;
}): { batchKey: string; runId: string } {
  const batchKey = [
    `requester-settle:${params.requesterAgentId ?? "unknown"}:${params.requesterSessionKey}:${params.batchRunIds.toSorted().join(",")}`,
    params.rearmGeneration === undefined ? undefined : `yield-${params.rearmGeneration}`,
  ]
    .filter(Boolean)
    .join(":");
  const attemptIndex = params.attemptIndex ?? 0;
  return {
    batchKey,
    runId: buildAnnounceIdempotencyKey(
      params.sharedAttemptKey || attemptIndex === 0
        ? batchKey
        : `${batchKey}:retry-${attemptIndex}`,
    ),
  };
}

export function isRequesterSettleWakeForRun(params: {
  entry: SubagentRunRecord;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  runsById: ReadonlyMap<string, SubagentRunRecord>;
}): boolean {
  const { entry, requesterSessionKey, requesterAgentId } = params;
  const wake = entry.requesterSettleWake;
  const batchRunIds = wake?.batchRunIds;
  if (
    entry.requesterSessionKey !== requesterSessionKey ||
    (entry.requesterAgentId && entry.requesterAgentId !== requesterAgentId) ||
    !wake ||
    wake.attemptCount < 1 ||
    params.runsById.get(entry.runId) !== entry ||
    !batchRunIds?.includes(entry.runId)
  ) {
    return false;
  }
  // Mirrors the frozen admission policy: a yielded private batch that was
  // admitted as deliverable retries under fresh keys like any public batch.
  const sharedAttemptKey =
    wake.yieldedFinalDeliverable !== true &&
    batchRunIds.some((runId) => {
      const member = params.runsById.get(runId);
      return (
        member?.requesterSessionKey === requesterSessionKey &&
        (!member.requesterAgentId || member.requesterAgentId === requesterAgentId) &&
        member.requesterSettleWake !== undefined &&
        member.requesterSettleWake.rearmGeneration === wake.rearmGeneration &&
        member.completionTarget === "parent"
      );
    });
  // Pending backoff still belongs to the last admitted attempt, not its next retry.
  return (
    params.runId ===
    buildRequesterSettleWakeIdentity({
      requesterSessionKey,
      requesterAgentId,
      batchRunIds,
      rearmGeneration: wake.rearmGeneration,
      attemptIndex: wake.attemptCount - 1,
      sharedAttemptKey,
    }).runId
  );
}
