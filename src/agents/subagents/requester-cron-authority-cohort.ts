import type { SubagentRunRecord } from "./registry/subagent-registry.types.js";
import { resolveCurrentRequesterSettleBatch } from "./registry/subagent-requester-settle-identity.js";
import { isSameSubagentRunOwner } from "./registry/subagent-run-generation.js";

/** The yield cohort and rearm generation whose continuation a requester authority owns. */
type RequesterAuthorityCohort = {
  batch: readonly SubagentRunRecord[];
  runs: ReadonlyMap<string, SubagentRunRecord>;
  rearmGeneration?: number;
};

/**
 * A consumed pause notice detaches its child into its own delivery wave. Every wave
 * stays inside the cohort; ids outside it may only name retired rows.
 */
export function isRequesterAuthorityCohortCurrent(
  cohort: RequesterAuthorityCohort,
  isBound: (entry: SubagentRunRecord) => boolean,
): boolean {
  const batch = resolveCurrentRequesterSettleBatch(cohort.batch, cohort.runs);
  if (
    !batch ||
    batch.some(
      (entry) =>
        entry.killIntent?.suppressTaskDelivery === true ||
        entry.killReconciliation?.suppressTaskDelivery === true,
    ) ||
    batch.every((entry) => entry.suppressCompletionDelivery === true)
  ) {
    return false;
  }
  const cohortRunIds = new Set(cohort.batch.map((entry) => entry.runId));
  return batch.every((entry) => {
    const wake = entry.requesterSettleWake;
    return (
      isBound(entry) &&
      (cohort.rearmGeneration === undefined ||
        (wake?.requesterYieldBatch === true &&
          wake.rearmGeneration === cohort.rearmGeneration &&
          wake.batchRunIds?.includes(entry.runId) === true &&
          wake.batchRunIds.every((runId) => cohortRunIds.has(runId) || !cohort.runs.has(runId))))
    );
  });
}

/** A delivery wave is the cohort members that still list exactly that wave. */
export function isRequesterAuthorityCohortWave(
  cohort: readonly SubagentRunRecord[],
  batch: readonly SubagentRunRecord[],
): boolean {
  const waveRunIds = batch.map((entry) => entry.runId).toSorted();
  return (
    batch.length > 0 &&
    batch.every((entry) => {
      const listed = entry.requesterSettleWake?.batchRunIds?.toSorted();
      return (
        cohort.some((member) => isSameSubagentRunOwner(member, entry)) &&
        listed?.length === waveRunIds.length &&
        listed.every((runId, index) => runId === waveRunIds[index])
      );
    })
  );
}

/** Cohort members outside a settled wave that still owe a same-generation wake. */
export function listOwedRequesterAuthorityMembers(
  cohort: RequesterAuthorityCohort,
  settled: readonly SubagentRunRecord[],
): SubagentRunRecord[] {
  return cohort.batch.filter((member) => {
    const current = cohort.runs.get(member.runId);
    return (
      !settled.some((entry) => isSameSubagentRunOwner(entry, member)) &&
      isSameSubagentRunOwner(current, member) &&
      current?.requesterSettleWake?.rearmGeneration === cohort.rearmGeneration
    );
  });
}
