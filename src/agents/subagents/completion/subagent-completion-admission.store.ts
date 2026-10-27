import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import type { QueuedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "../../../infra/session-delivery-queue.worker.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { retireSubagentCompletionControllerInput } from "../registry/subagent-controller-inputs.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "../registry/subagent-lifecycle-events.js";
import {
  getSubagentRunsForChildSession,
  subagentRuns,
} from "../registry/subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  runSubagentRegistryWorkerWrite,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryCommitReceiptError,
} from "../registry/subagent-registry-persistence.js";
import { isCanonicalSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  sameRequesterSettleRunIdentity,
  captureRequesterSettleWakeProgress,
} from "../registry/subagent-requester-settle-identity.js";
import {
  compareSubagentRunGeneration,
  isSameSubagentRunOwner,
} from "../registry/subagent-run-generation.js";
import { retiredCancellationEndedAt } from "./subagent-completion-mutation.kernel.js";
import type {
  BlockSubagentCompletionRequest,
  RequesterWakeCommittedWrite,
  RequesterWakeMutation,
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
  SubagentCompletionRecord,
} from "./subagent-completion-mutation.types.js";

export class SubagentCompletionSourceChangedError extends SubagentRegistryMutationRejectedError {}

type AdmissionReceipt =
  SessionDeliveryWorkerOperations["sessionDelivery.admitSubagentCompletion"]["output"];
type MutationReceipt = SubagentCompletionMutationResult & { writeId: string };

function parseAcknowledgedRecord(value: unknown): SubagentCompletionRecord {
  if (
    !isRecord(value) ||
    !isCanonicalSubagentRunRecord(value.subagent) ||
    typeof value.subagent.runId !== "string" ||
    !value.subagent.runId ||
    typeof value.subagent.childSessionKey !== "string" ||
    !value.subagent.childSessionKey ||
    typeof value.subagent.requesterSessionKey !== "string" ||
    !value.subagent.requesterSessionKey ||
    (value.cleanupHandled !== undefined && typeof value.cleanupHandled !== "boolean")
  ) {
    throw new Error("Subagent completion acknowledgment has an invalid native record");
  }
  return {
    subagent: value.subagent,
    cleanupHandled: value.cleanupHandled,
  };
}

function parseAdmissionReceipt(value: unknown, writeId: string, runId: string): AdmissionReceipt {
  if (
    !isRecord(value) ||
    value.writeId !== writeId ||
    typeof value.claimed !== "boolean" ||
    typeof value.status !== "string"
  ) {
    throw new Error("Subagent completion acknowledgment does not identify its write");
  }
  const record = parseAcknowledgedRecord(value.record);
  if (record.subagent.runId !== runId) {
    throw new Error("Subagent completion acknowledged another native owner");
  }
  return { writeId, claimed: value.claimed, status: value.status, record };
}

function parseMutationReceipt(
  value: unknown,
  writeId: string,
  runIds: readonly string[],
): MutationReceipt {
  if (
    !isRecord(value) ||
    value.writeId !== writeId ||
    (typeof value.applied !== "boolean" && value.applied !== null) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.retiredRunIds) ||
    !value.retiredRunIds.every((id): id is string => typeof id === "string" && runIds.includes(id))
  ) {
    throw new Error("Subagent completion mutation acknowledgment does not identify its write");
  }
  const records = value.records.map((record) => {
    const acknowledged = parseAcknowledgedRecord(record);
    if (!runIds.includes(acknowledged.subagent.runId)) {
      throw new Error("Subagent completion acknowledged another native owner");
    }
    return acknowledged;
  });
  return {
    writeId,
    applied: value.applied,
    records,
    retiredRunIds: value.retiredRunIds,
  };
}

function hasNewerGeneration(current: SubagentRunRecord): boolean {
  return [...getSubagentRunsForChildSession(current.childSessionKey, current.childAgentId)].some(
    (candidate) => compareSubagentRunGeneration(candidate, current) > 0,
  );
}

export async function admitSubagentCompletionDelivery(params: {
  runId: string;
  plan: (current: SubagentRunRecord) => {
    queueEntry: QueuedSessionDelivery;
    subagent: SubagentRunRecord;
  };
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
}): Promise<{
  id: string;
  claimed: boolean;
  status: DeliveryQueueStoredStatus;
  subagent: SubagentRunRecord;
}> {
  const expected = subagentRuns.get(params.runId);
  if (!expected) {
    throw new SubagentCompletionSourceChangedError("Subagent completion owner is unavailable");
  }
  return mutateSubagentRuns(
    [params.runId],
    (rows) => {
      const current = currentCompletionOwner(rows, expected);
      if (hasNewerGeneration(current)) {
        throw new SubagentCompletionSourceChangedError("Subagent completion source was replaced");
      }
      const prepared = params.plan(current);
      return {
        value: {
          id: prepared.queueEntry.id,
          claimed: false,
          status: "pending",
          subagent: current,
        },
        expected: current,
        ...prepared,
      };
    },
    {
      context: params.context,
      assertCurrent() {
        params.assertCurrent();
        if (!isSameSubagentRunOwner(subagentRuns.get(expected.runId), expected)) {
          throw new SubagentCompletionSourceChangedError(
            "Subagent completion owner changed before admission",
          );
        }
      },
      async commit(planned, authority) {
        const input = {
          writeId: randomUUID(),
          expected: planned.expected,
          subagent: planned.subagent,
          queueEntry: planned.queueEntry,
        };
        const receipt = await runSubagentRegistryWorkerWrite<AdmissionReceipt>(
          params.context,
          () => ({
            kind: "completion",
            writeId: input.writeId,
            assertCurrent: authority.assertCurrent,
            execute: (scope) =>
              scope.execute({ type: "sessionDelivery.admitSubagentCompletion", input }),
            decodeCommitted: (value) => parseAdmissionReceipt(value, input.writeId, params.runId),
          }),
        );
        const subagent = {
          ...receipt.record.subagent,
          cleanupHandled: planned.expected.cleanupHandled,
        };
        return {
          value: {
            id: planned.queueEntry.id,
            claimed: receipt.claimed,
            status: receipt.status,
            subagent,
          },
          postimages: new Map([[params.runId, subagent]]),
        };
      },
    },
  );
}

type CompletionMutationOptions = {
  context?: OpenClawStateWorkerContext;
  databaseOptions?: OpenClawStateDatabaseOptions;
  assertCurrent?: () => void;
};

type CompletionMutationPublication = {
  applied: boolean | null;
  publication: "published" | "unchanged";
};

function sameCompletionTerminalOwner(
  current: SubagentRunRecord,
  expected: SubagentRunRecord,
): boolean {
  if (current.terminalOwner === expected.terminalOwner) {
    return true;
  }
  // Cleanup retires the transient recovery marker, not the interrupted winner's settlement custody.
  return (
    expected.terminalOwner === "interrupted-recovery" &&
    current.terminalOwner === undefined &&
    current.cleanupCompletedAt !== undefined &&
    current.execution.suppressSessionEffects === true &&
    current.execution.status === "terminal" &&
    expected.execution.status === "terminal" &&
    current.endedReason === SUBAGENT_ENDED_REASON_ERROR &&
    expected.endedReason === current.endedReason &&
    current.execution.interruptionReason === "gateway-restart" &&
    expected.execution.interruptionReason === current.execution.interruptionReason &&
    current.execution.startedAt === expected.execution.startedAt &&
    current.execution.endedAt === expected.execution.endedAt &&
    current.execution.outcome?.status === "error" &&
    isDeepStrictEqual(current.execution.outcome, expected.execution.outcome)
  );
}

function currentCompletionOwner(
  rows: ReadonlyMap<string, SubagentRunRecord>,
  expected: SubagentRunRecord,
): SubagentRunRecord {
  const current = rows.get(expected.runId);
  if (
    !current ||
    !isSameSubagentRunOwner(current, expected) ||
    !sameRequesterSettleRunIdentity(current, expected) ||
    current.execution.lifecycleGeneration !== expected.execution.lifecycleGeneration ||
    !isDeepStrictEqual(current.childSessionIdentity, expected.childSessionIdentity) ||
    !isDeepStrictEqual(current.killIntent, expected.killIntent) ||
    current.killReconciliation?.killedAt !== expected.killReconciliation?.killedAt ||
    Boolean(current.killReconciliation?.taskCancellationAccepted) !==
      Boolean(expected.killReconciliation?.taskCancellationAccepted) ||
    Boolean(current.killReconciliation?.suppressTaskDelivery) !==
      Boolean(expected.killReconciliation?.suppressTaskDelivery) ||
    current.killReconciliation?.supersededAt !== expected.killReconciliation?.supersededAt ||
    (current.endedReason === SUBAGENT_ENDED_REASON_KILLED) !==
      (expected.endedReason === SUBAGENT_ENDED_REASON_KILLED) ||
    !sameCompletionTerminalOwner(current, expected) ||
    current.suppressAnnounceReason !== expected.suppressAnnounceReason
  ) {
    throw new SubagentCompletionSourceChangedError(
      "Subagent completion owner changed before mutation",
    );
  }
  return current;
}

async function mutateCompletion(
  entries: readonly SubagentRunRecord[],
  plan: (rows: ReadonlyMap<string, SubagentRunRecord>) => SubagentCompletionMutation,
  options: CompletionMutationOptions & {
    onCommitted?: (
      receipt: SubagentCompletionMutationResult,
      mutation: SubagentCompletionMutation,
    ) => void;
    onPublished?: (applied: boolean | null) => void;
  } = {},
): Promise<CompletionMutationPublication> {
  const runIds = entries.map((entry) => entry.runId);
  const context =
    options.context ??
    captureOpenClawStateWorkerContext({
      path: options.databaseOptions?.database?.path ?? options.databaseOptions?.path,
      env: options.databaseOptions?.env,
    });
  const result = await mutateSubagentRuns(
    runIds,
    (rows) => {
      const value: {
        applied: boolean | null;
        receiptRetentionFailure?: { error: unknown };
      } = { applied: null };
      return { value, mutation: plan(rows) };
    },
    {
      context,
      assertCurrent() {
        options.assertCurrent?.();
        for (const expected of entries) {
          const current = subagentRuns.get(expected.runId);
          if (current && !isSameSubagentRunOwner(current, expected)) {
            throw new SubagentCompletionSourceChangedError(
              "Subagent completion owner changed before mutation",
            );
          }
        }
      },
      onPublished(_postimages, value) {
        if (value.receiptRetentionFailure) {
          throw value.receiptRetentionFailure.error;
        }
        options.onPublished?.(value.applied);
      },
      async commit(planned, authority) {
        const input = {
          writeId: randomUUID(),
          mutation: planned.mutation,
        };
        const receipt = await runSubagentRegistryWorkerWrite<MutationReceipt>(context, () => ({
          kind: "completion",
          writeId: input.writeId,
          assertCurrent: authority.assertCurrent,
          execute: (scope) =>
            scope.execute({ type: "sessionDelivery.mutateSubagentCompletion", input }),
          decodeCommitted: (value) => parseMutationReceipt(value, input.writeId, runIds),
        }));
        const postimages = new Map<string, SubagentRunRecord | null>();
        for (const runId of receipt.retiredRunIds) {
          postimages.set(runId, null);
        }
        for (const { subagent, cleanupHandled } of receipt.records) {
          postimages.set(subagent.runId, { ...subagent, cleanupHandled });
        }
        if (receipt.applied === true && postimages.size !== runIds.length) {
          throw new SubagentRegistryCommitReceiptError(
            new Error("Subagent completion acknowledged an incomplete native publication"),
          );
        }
        // Retain known commits before source retirement can refuse their publication.
        let receiptRetentionFailure: { error: unknown } | undefined;
        try {
          options.onCommitted?.(receipt, planned.mutation);
        } catch (error) {
          // A custody callback failure cannot discard already committed postimages.
          receiptRetentionFailure = { error };
        }
        return {
          value: {
            applied: receipt.applied,
            receiptRetentionFailure,
          },
          postimages,
        };
      },
    },
  );
  return {
    applied: result.applied,
    publication: result.applied === true ? "published" : "unchanged",
  };
}

export async function settleSubagentCompletionDelivery(
  params: { subagent: SubagentRunRecord; queueId: string } & CompletionMutationOptions,
): Promise<void> {
  await mutateCompletion(
    [params.subagent],
    (rows) => {
      const current = currentCompletionOwner(rows, params.subagent);
      if (current.delivery?.generation !== params.subagent.delivery?.generation) {
        throw new SubagentCompletionSourceChangedError(
          "Subagent completion delivery generation changed",
        );
      }
      // The registry freezes the source row; only delivery changes here.
      const subagent = {
        ...current,
        delivery: current.delivery && { ...current.delivery },
      };
      const delivery = ensureDeliveryState(subagent);
      if (delivery.status !== "delivered" || delivery.queueId !== undefined) {
        const now = Date.now();
        Object.assign(delivery, {
          status: "delivered",
          disposition: "delivered",
          deliveredAt: now,
          announcedAt: now,
          lastError: undefined,
          nextAttemptAt: undefined,
          queueId: undefined,
          payload: undefined,
        });
      }
      return { kind: "settle", queueId: params.queueId, expected: current, subagent };
    },
    params,
  );
}

export async function blockSubagentCompletionDelivery(
  params: BlockSubagentCompletionRequest & CompletionMutationOptions,
): Promise<boolean> {
  const {
    context: _context,
    databaseOptions: _databaseOptions,
    assertCurrent: _assertCurrent,
    ...request
  } = params;
  if (params.storeReplaced) {
    const current = currentCompletionOwner(subagentRuns, params.subagent);
    subagentRuns.retireCompletionAuthority(current);
  }
  const result = await mutateCompletion(
    [params.subagent],
    (rows) => {
      const current = currentCompletionOwner(rows, params.subagent);
      if ((current.delivery?.generation ?? 1) !== (params.subagent.delivery?.generation ?? 1)) {
        throw new SubagentCompletionSourceChangedError(
          "Subagent completion delivery generation changed",
        );
      }
      return { kind: "block", params: { ...request, subagent: current }, now: Date.now() };
    },
    {
      ...params,
      onPublished(applied) {
        if (
          applied === true &&
          (params.suspendedReason ||
            params.operatorAuthorityUnavailable ||
            params.storeReplaced ||
            params.disposition === "permanent_failure")
        ) {
          // The durable outcome precedes releasing the completion input.
          retireSubagentCompletionControllerInput(params.subagent);
        }
      },
    },
  );
  return result.applied === true;
}

export async function reconcileRetiredSubagentCancellation(
  expected: SubagentRunRecord,
  now: number,
): Promise<boolean | undefined> {
  const endedAt = retiredCancellationEndedAt(expected, now);
  if (endedAt === undefined || !expected.killReconciliation) {
    return undefined;
  }
  try {
    const result = await mutateCompletion([expected], (rows) => {
      const current = currentCompletionOwner(rows, expected);
      if (retiredCancellationEndedAt(current, now) !== endedAt || hasNewerGeneration(current)) {
        throw new SubagentCompletionSourceChangedError("Subagent completion source was replaced");
      }
      return { kind: "reconcileCancelled", expected: current, now };
    });
    return result.applied ?? undefined;
  } catch (error) {
    if (error instanceof SubagentCompletionSourceChangedError) {
      return false;
    }
    throw error;
  }
}

function currentRequesterEntries(
  rows: ReadonlyMap<string, SubagentRunRecord>,
  entries: readonly SubagentRunRecord[],
  committed?: RequesterWakeCommittedWrite,
): Array<{ subagent: SubagentRunRecord }> {
  return entries.map((expected) => {
    if (!rows.has(expected.runId) && committed?.result.retiredRunIds.includes(expected.runId)) {
      return { subagent: expected };
    }
    const current = currentCompletionOwner(rows, expected);
    if (
      !committed &&
      (current.delivery?.generation !== expected.delivery?.generation ||
        !isDeepStrictEqual(
          captureRequesterSettleWakeProgress(current),
          captureRequesterSettleWakeProgress(expected),
        ))
    ) {
      throw new SubagentCompletionSourceChangedError(
        "Subagent requester wake cohort changed before mutation",
      );
    }
    return { subagent: current };
  });
}

type RequesterCompletionMutationOptions = CompletionMutationOptions & {
  committed?: RequesterWakeCommittedWrite;
  onCommitted?: (write: RequesterWakeCommittedWrite) => void;
  onPublished?: () => void;
};

/** The wake episode retains this receipt until its current host owner can adopt it. */
export async function mutateRequesterCompletionBatch(
  params: RequesterCompletionMutationOptions & {
    entries: readonly SubagentRunRecord[];
    assertCurrent: () => void;
    operation: RequesterWakeMutation | { kind: "settle"; outcome: SubagentAnnounceDeliveryResult };
  },
): Promise<CompletionMutationPublication> {
  return mutateCompletion(
    params.entries,
    (rows) => {
      const cohort = {
        entries: currentRequesterEntries(rows, params.entries, params.committed),
        committed: params.committed,
      };
      return params.operation.kind === "settle"
        ? { ...cohort, kind: "requesterBatch", outcome: params.operation.outcome, now: Date.now() }
        : { ...cohort, kind: "requesterWake", operation: params.operation };
    },
    {
      ...params,
      onPublished: () => params.onPublished?.(),
      onCommitted(result, mutation) {
        if (
          !params.committed &&
          (mutation.kind === "requesterBatch" || mutation.kind === "requesterWake")
        ) {
          params.onCommitted?.({ entries: mutation.entries, result });
        }
      },
    },
  );
}
