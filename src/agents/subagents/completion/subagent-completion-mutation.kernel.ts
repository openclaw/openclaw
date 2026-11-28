import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { loadDeliveryQueueEntryInDatabase } from "../../../infra/delivery-queue-sqlite-bound.js";
import {
  isProducedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import {
  matchesSubagentChildSessionOwner,
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
} from "../registry/subagent-child-owner-match.js";
import {
  consumeSubagentPauseNotice,
  completeRequesterSettleWakeState,
  transitionRequesterSettleWakeState,
  ensureDeliveryState,
  clearSubagentPendingDelivery,
  recordRequesterDelivery,
} from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import type { SubagentRunSqliteRow } from "../registry/subagent-registry.store.row.js";
import {
  loadSubagentRunsForChildSessionFromSqlite,
  readSubagentRun,
  readSubagentRunRow,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { sameRequesterSettleRunIdentity } from "../registry/subagent-requester-settle-identity.js";
import { isSubagentPausedByYield } from "../registry/subagent-requester-turn-custody.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
import type {
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
  SubagentCompletionRecord,
} from "./subagent-completion-mutation.types.js";

const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;
type CompletionMutation = {
  subagent: SubagentRunRecord;
  retire?: boolean;
};
const noMutation = (applied: boolean | null): SubagentCompletionMutationResult => ({
  applied,
  records: [],
  retiredRunIds: [],
});

/** Decode the committed row on the worker. */
export function decodeSubagentCompletionRecord(
  row: SubagentRunSqliteRow,
  cleanupHandled?: boolean,
): SubagentCompletionRecord {
  const subagent = expectDefined(
    rowToSubagentRunRecord(row),
    "subagent completion acknowledged native record",
  );
  return {
    subagent,
    cleanupHandled,
  };
}

export function retiredCancellationEndedAt(
  subagent: SubagentRunRecord,
  now: number,
): number | undefined {
  const endedAt = subagent.execution.endedAt;
  if (
    resolveSubagentChildAuthority(subagent).status === "mismatch" ||
    subagent.execution.status !== "terminal" ||
    subagent.execution.outcome?.status !== "error" ||
    subagent.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
    typeof endedAt !== "number" ||
    !Number.isFinite(endedAt) ||
    typeof subagent.cleanupCompletedAt !== "number" ||
    !Number.isFinite(subagent.cleanupCompletedAt) ||
    subagent.cleanupCompletedAt < endedAt ||
    subagent.pauseReason ||
    subagent.killIntent ||
    subagent.suppressAnnounceReason === "steer-restart" ||
    subagent.expectsCompletionMessage !== true ||
    subagent.completion?.required !== true ||
    !subagent.requesterSettleWake ||
    subagent.delivery?.status !== "pending" ||
    subagent.delivery.queueId ||
    endedAt + SUSPENDED_RETENTION_MS > now
  ) {
    return undefined;
  }
  return endedAt;
}

function ownsRetiredCancellation(
  database: OpenClawStateDatabase,
  subagent: SubagentRunRecord,
  expected: SubagentRunRecord,
): boolean {
  const newerSibling = (candidate: SubagentRunRecord) =>
    matchesSubagentChildSessionOwner(
      candidate,
      subagent.childSessionKey,
      resolveSubagentChildAgentId(subagent),
    ) && compareSubagentRunGeneration(candidate, subagent) > 0;
  return (
    compareSubagentRunGeneration(subagent, expected) === 0 &&
    !loadSubagentRunsForChildSessionFromSqlite(subagent.childSessionKey, database).some(
      newerSibling,
    )
  );
}

function markDelivered(subagent: SubagentRunRecord, deliveredAt: number): void {
  Object.assign(ensureDeliveryState(subagent), {
    status: "delivered",
    disposition: "delivered",
    deliveredAt,
    announcedAt: deliveredAt,
    lastDropReason: undefined,
  });
  clearSubagentPendingDelivery(subagent);
}

/** The store appended the child's status to requester history; settle the owed delivery. */
function prepareHistorySettledCompletion(
  expected: SubagentRunRecord,
  now: number,
  subagent: SubagentRunRecord | null,
): CompletionMutation | undefined {
  if (
    !subagent ||
    subagent.execution.status !== "terminal" ||
    isSubagentPausedByYield(subagent) ||
    subagent.expectsCompletionMessage === false ||
    subagent.delivery?.status === "delivered" ||
    (subagent.delivery?.generation ?? 1) !== (expected.delivery?.generation ?? 1)
  ) {
    return undefined;
  }
  markDelivered(subagent, now);
  Object.assign(ensureDeliveryState(subagent), { queueId: undefined });
  subagent.wakeOnDescendantSettle = undefined;
  return { subagent };
}

function commitCompletionMutations(
  database: OpenClawStateDatabase,
  mutations: readonly CompletionMutation[],
): SubagentCompletionMutationResult {
  const rows = mutations
    .filter((mutation) => !mutation.retire)
    .map(({ subagent }) => ({
      row: bindSubagentRunRecord(subagent),
      cleanupHandled: subagent.cleanupHandled,
    }));
  const retired = mutations.filter((mutation) => mutation.retire);
  const retiredRunIds = retired.map(({ subagent }) => subagent.runId);
  writeSubagentRunValuesInDatabase(
    database,
    rows.map(({ row }) => row),
    retiredRunIds,
    retiredRunIds.length
      ? {
          reason: "requester_settled",
          terminalRows: new Map(retired.map(({ subagent }) => [subagent.runId, subagent])),
        }
      : undefined,
  );
  return {
    applied: true,
    records: rows.map(({ row, cleanupHandled }) =>
      decodeSubagentCompletionRecord(row, cleanupHandled),
    ),
    retiredRunIds,
  };
}

function prepareRequesterBatch(
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" | "requesterBatch" }>,
): Array<{ expected: SubagentRunRecord; subagent: SubagentRunRecord }> {
  const entries = params.entries;
  const first = entries[0]?.subagent;
  const cohort = first?.requesterSettleWake?.batchRunIds?.toSorted().join("\0");
  return entries.map(({ subagent: expected }) => {
    const changedOwner = () =>
      new Error("subagent completion owner changed before settlement: " + expected.runId);
    // The registry FIFO supplies the current committed postimage; keep its input immutable.
    const subagent = structuredClone(expected);
    if (
      !subagent.requesterSettleWake ||
      subagent.requesterSessionKey !== first?.requesterSessionKey ||
      subagent.requesterAgentId !== first?.requesterAgentId ||
      subagent.requesterSettleWake.rearmGeneration !==
        first?.requesterSettleWake?.rearmGeneration ||
      subagent.requesterSettleWake.batchRunIds?.toSorted().join("\0") !== cohort
    ) {
      throw changedOwner();
    }
    // Admission owns the selected partition. Unselected siblings retain their outcomes.
    return { expected, subagent };
  });
}

function mutateRequesterBatch(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" | "requesterBatch" }>,
): SubagentCompletionMutationResult {
  if (params.committed) {
    return reconcileRequesterWake(database, params);
  }
  const batch = prepareRequesterBatch(params);
  const mutations = batch.map(({ subagent }): CompletionMutation => {
    if (params.kind === "requesterWake") {
      if (params.operation.kind === "requesterDelivery") {
        recordRequesterDelivery(subagent, params.operation.fact);
        return { subagent };
      }
      if (params.operation.kind === "complete") {
        return { subagent, retire: completeRequesterSettleWakeState(subagent) };
      }
      if (
        isSubagentPausedByYield(subagent) &&
        Boolean(subagent.requesterSettleWake?.pauseNotice) !==
          Boolean(params.operation.state.pauseNotice)
      ) {
        throw new Error("Requester pause notice changed before transition");
      }
      if (
        (subagent.requesterSettleWake?.yieldedFinalDeliverable === true) !==
        (params.operation.state.yieldedFinalDeliverable === true)
      ) {
        throw new Error("Requester wake reply policy changed before transition");
      }
      transitionRequesterSettleWakeState(subagent, params.operation.state);
      if (params.operation.requesterDelivery) {
        recordRequesterDelivery(subagent, params.operation.requesterDelivery);
      }
      return { subagent };
    }
    const now = params.now;
    // A notice is one paused member's input, not settlement of its frozen cohort.
    if (consumeSubagentPauseNotice(subagent)) {
      return { subagent };
    }
    // A batch that missed its turn already has its status in requester history.
    if (
      !isSubagentPausedByYield(subagent) &&
      subagent.expectsCompletionMessage === true &&
      ["pending", "in_progress", "failed", "suspended"].includes(
        subagent.delivery?.status ?? "pending",
      )
    ) {
      markDelivered(
        subagent,
        (params.outcome.delivered ? params.outcome.deliveredAt : undefined) ?? now,
      );
    }
    return { subagent, retire: completeRequesterSettleWakeState(subagent) };
  });
  return commitCompletionMutations(database, mutations);
}

function reconcileRequesterWake(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" | "requesterBatch" }>,
): SubagentCompletionMutationResult {
  const committed = params.committed;
  if (!committed || committed.result.applied !== true) {
    throw new Error("Requester wake reconciliation requires its committed native receipt");
  }
  const result = noMutation(true);
  for (const { subagent: expected } of params.entries) {
    const original = committed.entries.find(
      ({ subagent }) => subagent.runId === expected.runId,
    )?.subagent;
    if (!original || !sameRequesterSettleRunIdentity(original, expected)) {
      throw new Error("Requester wake reconciliation lost its original generation");
    }
    const row = readSubagentRunRow(database, expected.runId);
    if (
      loadSubagentRunsForChildSessionFromSqlite(original.childSessionKey, database).some(
        (candidate) =>
          matchesSubagentChildSessionOwner(
            candidate,
            original.childSessionKey,
            resolveSubagentChildAgentId(original),
          ) && compareSubagentRunGeneration(candidate, original) > 0,
      )
    ) {
      throw new Error("Requester wake reconciliation was superseded");
    }
    if (committed.result.retiredRunIds.includes(expected.runId)) {
      if (row) {
        throw new Error("Requester wake retirement has another native owner");
      }
      result.retiredRunIds.push(expected.runId);
      continue;
    }
    const acknowledged = committed.result.records.find(
      ({ subagent }) => subagent.runId === expected.runId,
    );
    const intended = acknowledged?.subagent;
    const current = row && decodeSubagentCompletionRecord(row).subagent;
    if (
      !row ||
      !current ||
      !intended ||
      !sameRequesterSettleRunIdentity(current, original) ||
      !sameRequesterSettleRunIdentity(intended, original) ||
      current.pauseReason !== intended.pauseReason ||
      current.completionTarget !== intended.completionTarget ||
      current.expectsCompletionMessage !== intended.expectsCompletionMessage ||
      current.delivery?.generation !== intended.delivery?.generation ||
      !isDeepStrictEqual(current.execution, intended.execution) ||
      !isDeepStrictEqual(current.killIntent, intended.killIntent) ||
      !isDeepStrictEqual(current.killReconciliation, intended.killReconciliation) ||
      !isDeepStrictEqual(current.requesterSettleWake, intended.requesterSettleWake) ||
      current.retireAfterSettle !== intended.retireAfterSettle ||
      (params.kind === "requesterBatch" &&
        (!isDeepStrictEqual(current.delivery, intended.delivery) ||
          current.suppressCompletionDelivery !== intended.suppressCompletionDelivery ||
          current.wakeOnDescendantSettle !== intended.wakeOnDescendantSettle))
    ) {
      throw new Error("Requester wake committed state no longer owns reconciliation");
    }
    // The completed write is not replayed. Publish current canonical fields so
    // independent cleanup cannot be overwritten by the older acknowledgement.
    result.records.push(decodeSubagentCompletionRecord(row, expected.cleanupHandled));
  }
  return result;
}

/** Worker transaction owner supplies the handle and live admission before/after this mutation. */
export function mutateSubagentCompletionInDatabase(
  database: OpenClawStateDatabase,
  mutation: SubagentCompletionMutation,
): SubagentCompletionMutationResult {
  switch (mutation.kind) {
    case "settle": {
      const queued = loadDeliveryQueueEntryInDatabase(
        database,
        SESSION_DELIVERY_QUEUE_NAME,
        mutation.queueId,
        "pending",
        // SAFETY: The session namespace stores only the canonical delivery payload.
      ) as QueuedSessionDelivery | null;
      const owner = queued?.kind === "agentTurn" ? queued.owner : undefined;
      const row = readSubagentRunRow(database, mutation.expected.runId);
      const current = row && decodeSubagentCompletionRecord(row).subagent;
      const delivery = current?.delivery;
      if (
        !current ||
        !delivery ||
        !queued ||
        !isProducedSessionDelivery(queued) ||
        !owner ||
        owner.kind !== "subagent_completion" ||
        owner.runId !== current.runId ||
        owner.generation !== delivery.generation ||
        owner.deadlineAt !== delivery.deadlineAt ||
        (queued.settlementOutcome ??
          (queued.acknowledgedAt !== undefined ? "recovered" : undefined)) !== "recovered" ||
        compareSubagentRunGeneration(current, mutation.expected) !== 0 ||
        current.childSessionKey !== mutation.expected.childSessionKey ||
        current.requesterSessionKey !== mutation.expected.requesterSessionKey ||
        current.requesterStorePath !== mutation.expected.requesterStorePath
      ) {
        throw new Error(
          "Subagent completion settlement lost its produced delivery or native owner",
        );
      }
      if (delivery.status === "delivered" && delivery.queueId === undefined) {
        // A marked queue retains producer cleanup after a committed write. Reconcile
        // the current native row without replaying its write or terminal timestamps.
        return {
          applied: true,
          records: [decodeSubagentCompletionRecord(row, mutation.expected.cleanupHandled)],
          retiredRunIds: [],
        };
      }
      if (delivery.queueId !== mutation.queueId) {
        throw new Error("Subagent completion owner changed before settlement");
      }
      return commitCompletionMutations(database, [{ subagent: mutation.subagent }]);
    }
    case "settleInHistory": {
      const prepared = prepareHistorySettledCompletion(
        mutation.subagent,
        mutation.now,
        readSubagentRun(database, mutation.subagent.runId),
      );
      return prepared ? commitCompletionMutations(database, [prepared]) : noMutation(false);
    }
    case "reconcileCancelled": {
      const { expected, now } = mutation;
      const endedAt = retiredCancellationEndedAt(expected, now);
      const marker = expected.killReconciliation;
      if (endedAt === undefined || !marker) {
        return noMutation(null);
      }
      if (!Number.isFinite(marker.killedAt)) {
        return noMutation(false);
      }
      // A cleanup kill may arrive after execution ended. The current generation,
      // not timestamp ordering, owns reconciliation of that retired cancellation.
      const current = readSubagentRun(database, expected.runId);
      if (
        !current ||
        retiredCancellationEndedAt(current, now) !== endedAt ||
        !ownsRetiredCancellation(database, current, expected)
      ) {
        return noMutation(false);
      }
      current.killReconciliation = undefined;
      return commitCompletionMutations(database, [{ subagent: current }]);
    }
    case "requesterBatch":
    case "requesterWake":
      return mutateRequesterBatch(database, mutation);
  }
  throw new Error("Unknown subagent completion mutation");
}
