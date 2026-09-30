import { isDeepStrictEqual } from "node:util";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue.records.js";
import { resolveEventSessionKey } from "../../../routing/session-key.js";
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db-contract.js";
import {
  completeRequesterSettleWakeState,
  transitionRequesterSettleWakeState,
  ensureCompletionState,
  ensureDeliveryState,
  isCompletedRequesterDeliveryBlocked,
  clearSubagentPendingDelivery,
  loadPendingFinalDeliveryPayload,
  markRequesterSettleWakePending,
} from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { consumeSubagentPauseNotice } from "../registry/subagent-registry-run-pause.js";
import {
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "../registry/subagent-registry.store.codec.js";
import {
  deleteSubagentRunRowInDatabase,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.kernel.js";
import {
  loadSubagentRunsForChildSessionFromSqlite,
  readSubagentRun,
  readSubagentRunRow,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { captureRequesterSettleRunIdentity } from "../registry/subagent-requester-settle-identity.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
import type {
  BlockSubagentCompletionRequest,
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
} from "./subagent-completion-mutation.types.js";
import {
  readSubagentCompletionQueueReceipt,
  reconcileSubagentCompletionQueueReceipts,
} from "./subagent-completion-queue-receipt.js";

const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;
type CompletionMutation = {
  subagent: SubagentRunRecord;
  queued?: QueuedSessionDelivery;
  retire?: boolean;
};
const noMutation = (applied: boolean | null): SubagentCompletionMutationResult => ({
  applied,
  records: [],
  retiredRunIds: [],
  queueIds: [],
});

export function retiredCancellationEndedAt(
  subagent: SubagentRunRecord,
  now: number,
): number | undefined {
  const endedAt = subagent.execution.endedAt;
  if (
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
    subagent.terminalOwner ||
    subagent.execution.restartRecovery ||
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
    candidate.childSessionKey === subagent.childSessionKey &&
    compareSubagentRunGeneration(candidate, subagent) > 0;
  return (
    bindSubagentRunRecord(subagent).payload_json === bindSubagentRunRecord(expected).payload_json &&
    !loadSubagentRunsForChildSessionFromSqlite(subagent.childSessionKey, database).some(
      newerSibling,
    )
  );
}

// One mutation kernel serves ordinary blocking and whole requester-batch settlement.
// It only prepares records; its caller owns the transaction and final publication.
function prepareBlockedSubagentCompletion(
  database: OpenClawStateDatabase,
  params: BlockSubagentCompletionRequest,
  now: number,
  subagent: SubagentRunRecord | null,
): CompletionMutation | undefined {
  const generation = params.subagent.delivery?.generation ?? 1;
  if (
    !subagent ||
    subagent.execution.status !== "terminal" ||
    !subagent.execution.outcome ||
    subagent.pauseReason === "sessions_yield" ||
    subagent.expectsCompletionMessage !== true ||
    (subagent.delivery?.generation ?? 1) !== generation ||
    bindSubagentRunRecord(subagent).payload_json !==
      bindSubagentRunRecord(params.subagent).payload_json
  ) {
    return undefined;
  }
  const successful = subagent.execution.outcome?.status === "ok";
  if (
    !successful &&
    ((params.suspendedReason !== undefined && !params.storeReplaced) ||
      !["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending"))
  ) {
    return undefined;
  }
  // Historical cancelled wakes retain their exact native owner. Capture their
  // intentional empty result only after kill reconciliation has committed.
  const retiredEndedAt = retiredCancellationEndedAt(subagent, now);
  if (retiredEndedAt !== undefined) {
    if (
      subagent.killReconciliation ||
      !ownsRetiredCancellation(database, subagent, params.subagent)
    ) {
      return undefined;
    }
    const completion = ensureCompletionState(subagent);
    completion.resultText ??= null;
    completion.capturedAt ??= retiredEndedAt;
  }
  const delivery = ensureDeliveryState(subagent);
  if (
    params.storeReplaced &&
    (delivery.status === "delivered" ||
      delivery.announcedAt !== undefined ||
      delivery.deliveredAt !== undefined)
  ) {
    return undefined;
  }
  delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
  if (typeof params.enqueuedAt === "number") {
    delivery.enqueuedAt ??= params.enqueuedAt;
  }
  Object.assign(delivery, {
    status: params.suspendedReason ? ("suspended" as const) : ("failed" as const),
    disposition: params.storeReplaced
      ? ("intentional_non_delivery" as const)
      : params.suspendedReason
        ? ("permanent_failure" as const)
        : (params.disposition ?? delivery.disposition),
    lastError: params.reason,
    deliveredAt: undefined,
    announcedAt: undefined,
    suspendedAt: params.suspendedReason ? (delivery.suspendedAt ?? now) : delivery.suspendedAt,
    suspendedReason: params.suspendedReason ?? delivery.suspendedReason,
    lastDropReason: params.lastDropReason ?? delivery.lastDropReason,
    nextAttemptAt: undefined,
    queueId: undefined,
  });
  Object.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: undefined });
  if (params.storeReplaced) {
    subagent.requesterSettleWake = undefined;
  } else if (params.suspendedReason) {
    if (isCompletedRequesterDeliveryBlocked(subagent)) {
      // This requester already ran. An ordinary settle wake would replay it;
      // a separately owned yield batch still has genuine unfinished work.
      if (subagent.requesterSettleWake?.requesterYieldBatch !== true) {
        subagent.requesterSettleWake = undefined;
      }
    } else {
      markRequesterSettleWakePending(subagent);
    }
  } else {
    subagent.suppressCompletionDelivery = true;
  }
  const text =
    successful && !params.storeReplaced
      ? "Subagent completion delivery is blocked: " + params.reason
      : null;
  const queued = text
    ? prepareClaimedSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: resolveEventSessionKey(subagent.requesterSessionKey),
          ...(subagent.requesterAgentId ? { agentId: subagent.requesterAgentId } : {}),
          text,
          ...(subagent.requesterOrigin ? { deliveryContext: subagent.requesterOrigin } : {}),
          idempotencyKey: `subagent-completion-blocked:${subagent.runId}:generation:${generation}`,
        },
        0,
        now,
      )
    : undefined;
  return { subagent, queued };
}

function commitCompletionMutations(
  database: OpenClawStateDatabase,
  mutations: readonly CompletionMutation[],
): SubagentCompletionMutationResult {
  for (const { subagent, queued, retire } of mutations) {
    if (queued) {
      upsertBoundDeliveryQueueEntryInDatabase(
        bindDeliveryQueueEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          entry: queued,
          insertOnly: true,
        }),
        database,
      );
    }
    if (retire) {
      deleteSubagentRunRowInDatabase(database, subagent.runId);
    } else {
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(subagent));
    }
  }
  const queueIds = mutations.flatMap(({ queued }) => (queued ? [queued.id] : []));
  return {
    applied: true,
    records: mutations
      .filter((mutation) => !mutation.retire)
      .map(({ subagent }) => {
        const row = readSubagentRunRow(database, subagent.runId);
        if (!row) {
          throw new Error("Subagent completion mutation lost its native row");
        }
        return { row, cleanupHandled: subagent.cleanupHandled };
      }),
    retiredRunIds: mutations
      .filter((mutation) => mutation.retire)
      .map(({ subagent }) => subagent.runId),
    queueIds,
    ...(queueIds.length > 0
      ? { queueReceipts: queueIds.map((id) => readSubagentCompletionQueueReceipt(database, id)) }
      : {}),
  };
}

function readRequesterBatch(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" | "requesterBatch" }>,
): Array<{ expected: SubagentRunRecord; subagent: SubagentRunRecord }> {
  const entries = params.entries;
  const ids = new Set(entries.map(({ subagent }) => subagent.runId));
  const first = entries[0]?.subagent;
  const cohort = first?.requesterSettleWake?.batchRunIds?.toSorted().join("\0");
  const checkedOmittedIds = new Set<string>();
  return entries.map(({ subagent: expected }) => {
    const changedOwner = () =>
      new Error("subagent completion owner changed before settlement: " + expected.runId);
    const subagent = readSubagentRun(database, expected.runId);
    if (
      !subagent ||
      !subagent.requesterSettleWake ||
      subagent.requesterSessionKey !== first?.requesterSessionKey ||
      subagent.requesterAgentId !== first?.requesterAgentId ||
      subagent.requesterSettleWake.rearmGeneration !==
        first?.requesterSettleWake?.rearmGeneration ||
      subagent.requesterSettleWake.batchRunIds?.toSorted().join("\0") !== cohort ||
      bindSubagentRunRecord(subagent).payload_json !== bindSubagentRunRecord(expected).payload_json
    ) {
      throw changedOwner();
    }
    // Outcome settlement owns the whole frozen wave; quiet wake decisions may select
    // current members without settling the remaining siblings' delivery outcomes.
    for (const id of params.kind === "requesterBatch" &&
    !(subagent.pauseReason === "sessions_yield" && subagent.requesterSettleWake.pauseNotice)
      ? (subagent.requesterSettleWake?.batchRunIds ?? [])
      : []) {
      if (!ids.has(id) && !checkedOmittedIds.has(id)) {
        const member = readSubagentRun(database, id);
        if (
          member?.requesterSettleWake &&
          member.requesterSettleWake.rearmGeneration ===
            subagent.requesterSettleWake?.rearmGeneration
        ) {
          throw changedOwner();
        }
        // Planning performs no writes, so this check holds for the remaining same-wave rows.
        checkedOmittedIds.add(id);
      }
    }
    // Decoding restores restart defaults, not the active process's cleanup ownership.
    subagent.cleanupHandled = expected.cleanupHandled;
    return { expected, subagent };
  });
}

function settleRequesterBatch(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterBatch" }>,
): SubagentCompletionMutationResult {
  if (params.committed) {
    return reconcileRequesterWake(database, params);
  }
  const now = params.now;
  const mutations = readRequesterBatch(database, params).map(
    ({ expected, subagent }): CompletionMutation => {
      if (consumeSubagentPauseNotice(subagent)) {
        // A notice is one paused member's input, not settlement of its frozen cohort.
        if (
          params.outcome.storeReplaced ||
          params.outcome.disposition === "intentional_non_delivery"
        ) {
          subagent.requesterSettleWake = undefined;
        }
        return { subagent };
      }
      const changedOwner = () =>
        new Error("subagent completion owner changed before settlement: " + expected.runId);
      // An exact requester receipt can arrive after expiry transferred this result to its wake.
      const acknowledgeExpiredDelivery =
        params.outcome.delivered &&
        subagent.delivery?.status === "suspended" &&
        subagent.delivery.suspendedReason === "expiry";
      let mutation: CompletionMutation = { subagent };
      if (
        subagent.pauseReason !== "sessions_yield" &&
        subagent.expectsCompletionMessage === true &&
        (["pending", "in_progress"].includes(subagent.delivery?.status ?? "pending") ||
          acknowledgeExpiredDelivery)
      ) {
        if (params.outcome.delivered) {
          const delivery = ensureDeliveryState(subagent);
          const deliveredAt = params.outcome.deliveredAt ?? now;
          Object.assign(delivery, {
            status: "delivered",
            disposition: "delivered",
            deliveredAt,
            announcedAt: deliveredAt,
            lastDropReason: undefined,
          });
          clearSubagentPendingDelivery(subagent);
        } else {
          const blocked = prepareBlockedSubagentCompletion(
            database,
            {
              subagent: expected,
              reason:
                params.outcome.error ?? params.outcome.reason ?? "requester settle wake failed",
              disposition: params.outcome.disposition,
              storeReplaced: params.outcome.storeReplaced,
              suspendedReason: params.outcome.storeReplaced ? "permanent_failure" : undefined,
            },
            now,
            subagent,
          );
          if (!blocked) {
            throw changedOwner();
          }
          mutation = blocked;
        }
      }
      mutation.retire = completeRequesterSettleWakeState(mutation.subagent);
      return mutation;
    },
  );
  return commitCompletionMutations(database, mutations);
}

function reconcileRequesterWake(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" | "requesterBatch" }>,
): SubagentCompletionMutationResult {
  const committed = params.committed;
  if (
    !committed ||
    committed.result.applied !== true ||
    (params.kind === "requesterWake" && committed.result.queueIds.length !== 0)
  ) {
    throw new Error("Requester wake reconciliation requires its committed native receipt");
  }
  const result = noMutation(true);
  for (const { subagent: expected } of params.entries) {
    const original = committed.entries.find(
      ({ subagent }) => subagent.runId === expected.runId,
    )?.subagent;
    const originalCanonical = original && rowToSubagentRunRecord(bindSubagentRunRecord(original));
    const expectedCanonical = rowToSubagentRunRecord(bindSubagentRunRecord(expected));
    if (
      !originalCanonical ||
      !expectedCanonical ||
      !isDeepStrictEqual(
        captureRequesterSettleRunIdentity(originalCanonical),
        captureRequesterSettleRunIdentity(expectedCanonical),
      )
    ) {
      throw new Error("Requester wake reconciliation lost its original generation");
    }
    const row = readSubagentRunRow(database, expected.runId);
    if (
      loadSubagentRunsForChildSessionFromSqlite(originalCanonical.childSessionKey, database).some(
        (candidate) => compareSubagentRunGeneration(candidate, originalCanonical) > 0,
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
      ({ row: record }) => record.run_id === expected.runId,
    );
    const intended = acknowledged && rowToSubagentRunRecord(acknowledged.row);
    const current = row && rowToSubagentRunRecord(row);
    if (
      !row ||
      !current ||
      !intended ||
      !isDeepStrictEqual(
        captureRequesterSettleRunIdentity(current),
        captureRequesterSettleRunIdentity(originalCanonical),
      ) ||
      !isDeepStrictEqual(
        captureRequesterSettleRunIdentity(intended),
        captureRequesterSettleRunIdentity(originalCanonical),
      ) ||
      current.pauseReason !== intended.pauseReason ||
      current.completionTarget !== intended.completionTarget ||
      current.expectsCompletionMessage !== intended.expectsCompletionMessage ||
      current.delivery?.generation !== intended.delivery?.generation ||
      !isDeepStrictEqual(current.execution, intended.execution) ||
      !isDeepStrictEqual(current.killIntent, intended.killIntent) ||
      !isDeepStrictEqual(current.killReconciliation, intended.killReconciliation) ||
      !isDeepStrictEqual(current.requesterSettleWake, intended.requesterSettleWake) ||
      current.retireAfterRequesterTurn !== intended.retireAfterRequesterTurn ||
      (params.kind === "requesterBatch" &&
        (!isDeepStrictEqual(current.delivery, intended.delivery) ||
          current.suppressCompletionDelivery !== intended.suppressCompletionDelivery ||
          current.wakeOnDescendantSettle !== intended.wakeOnDescendantSettle))
    ) {
      throw new Error("Requester wake committed state no longer owns reconciliation");
    }
    // The completed write is not replayed. Publish current canonical fields so
    // independent cleanup cannot be overwritten by the older acknowledgement.
    result.records.push({ row, cleanupHandled: expected.cleanupHandled });
  }
  if (committed.result.queueIds.length > 0) {
    const receipts = reconcileSubagentCompletionQueueReceipts(
      database,
      committed.result.queueIds,
      committed.result.queueReceipts,
    ).filter((receipt) => receipt.status === "pending");
    result.queueIds = receipts.map(({ id }) => id);
    if (receipts.length > 0) {
      result.queueReceipts = receipts;
    }
  }
  return result;
}

function mutateRequesterWake(
  database: OpenClawStateDatabase,
  params: Extract<SubagentCompletionMutation, { kind: "requesterWake" }>,
): SubagentCompletionMutationResult {
  if (params.committed) {
    return reconcileRequesterWake(database, params);
  }
  const mutations = readRequesterBatch(database, params).map(({ subagent }): CompletionMutation => {
    if (params.operation.kind === "complete") {
      return { subagent, retire: completeRequesterSettleWakeState(subagent) };
    }
    if (
      subagent.pauseReason === "sessions_yield" &&
      Boolean(subagent.requesterSettleWake?.pauseNotice) !==
        Boolean(params.operation.state.pauseNotice)
    ) {
      throw new Error("Requester pause notice changed before transition");
    }
    transitionRequesterSettleWakeState(subagent, params.operation.state);
    return { subagent };
  });
  return commitCompletionMutations(database, mutations);
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
      const current = row && rowToSubagentRunRecord(row);
      if (
        !current ||
        !queued ||
        !owner ||
        owner.kind !== "subagent_completion" ||
        owner.runId !== current.runId ||
        owner.generation !== current.delivery?.generation ||
        owner.deadlineAt !== current.delivery.deadlineAt ||
        (queued.settlementOutcome ??
          (queued.acknowledgedAt !== undefined ? "recovered" : undefined)) !== "recovered" ||
        compareSubagentRunGeneration(current, mutation.expected) !== 0 ||
        current.childSessionKey !== mutation.expected.childSessionKey ||
        current.requesterSessionKey !== mutation.expected.requesterSessionKey ||
        current.requesterStorePath !== mutation.expected.requesterStorePath
      ) {
        throw new Error("Subagent completion recovery lost its queue or native owner");
      }
      if (current.delivery.status === "delivered" && current.delivery.queueId === undefined) {
        // A marked queue retains producer cleanup after a committed write. Reconcile
        // the current native row without replaying its write or terminal timestamps.
        return {
          applied: true,
          records: [{ row, cleanupHandled: mutation.expected.cleanupHandled }],
          retiredRunIds: [],
          queueIds: [],
        };
      }
      if (
        current.delivery.queueId !== mutation.queueId ||
        bindSubagentRunRecord(current).payload_json !==
          bindSubagentRunRecord(mutation.expected).payload_json
      ) {
        throw new Error("Subagent completion owner changed before settlement");
      }
      return commitCompletionMutations(database, [{ subagent: mutation.subagent }]);
    }
    case "block": {
      const prepared = prepareBlockedSubagentCompletion(
        database,
        mutation.params,
        mutation.now,
        readSubagentRun(database, mutation.params.subagent.runId),
      );
      return prepared ? commitCompletionMutations(database, [prepared]) : noMutation(false);
    }
    case "reconcileCancelled": {
      const { expected, now } = mutation;
      const endedAt = retiredCancellationEndedAt(expected, now);
      const marker = expected.killReconciliation;
      if (
        endedAt === undefined ||
        !marker ||
        !Number.isFinite(marker.killedAt) ||
        marker.killedAt > endedAt
      ) {
        return noMutation(null);
      }
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
      return settleRequesterBatch(database, mutation);
    case "requesterWake":
      return mutateRequesterWake(database, mutation);
  }
  throw new Error("Unknown subagent completion mutation");
}
