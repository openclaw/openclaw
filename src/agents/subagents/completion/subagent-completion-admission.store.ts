import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import type { QueuedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "../../../infra/session-delivery-queue.worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import {
  getSubagentRunsForChildSession,
  subagentRuns,
} from "../registry/subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryWriteError,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryCommitReceiptError,
  SubagentRegistryVersionConflictError,
} from "../registry/subagent-registry-persistence.js";
import { rowToSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import {
  subagentRunRowVersion,
  type SubagentRunSqliteRow,
} from "../registry/subagent-registry.store.row.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  captureRequesterSettleRunIdentity,
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
  SubagentCompletionQueueReceipt,
} from "./subagent-completion-mutation.types.js";

const log = createSubsystemLogger("subagents/completion");
export class SubagentCompletionSourceChangedError extends SubagentRegistryMutationRejectedError {}

type AdmissionReceipt = Exclude<
  SessionDeliveryWorkerOperations["sessionDelivery.admitSubagentCompletion"]["output"],
  { conflictRunIds: string[] }
>;
type MutationReceipt = SubagentCompletionMutationResult & { writeId: string };
type CompletionCommand = {
  [Key in "sessionDelivery.admitSubagentCompletion" | "sessionDelivery.mutateSubagentCompletion"]: {
    type: Key;
    input: SessionDeliveryWorkerOperations[Key]["input"];
  };
}["sessionDelivery.admitSubagentCompletion" | "sessionDelivery.mutateSubagentCompletion"];

function parseNativeRow(row: unknown): SubagentRunSqliteRow {
  if (
    !isRecord(row) ||
    typeof row.run_id !== "string" ||
    typeof row.child_session_key !== "string" ||
    typeof row.requester_session_key !== "string" ||
    typeof row.created_at !== "number" ||
    typeof row.payload_json !== "string" ||
    (row.controller_session_key !== null && typeof row.controller_session_key !== "string") ||
    (row.requester_store_path !== null && typeof row.requester_store_path !== "string") ||
    (row.controller_store_path !== null && typeof row.controller_store_path !== "string")
  ) {
    throw new Error("Subagent completion acknowledgment has an invalid native record");
  }
  return {
    run_id: row.run_id,
    child_session_key: row.child_session_key,
    requester_session_key: row.requester_session_key,
    controller_session_key: row.controller_session_key,
    requester_store_path: row.requester_store_path,
    controller_store_path: row.controller_store_path,
    created_at: row.created_at,
    payload_json: row.payload_json,
  };
}

function parseVersionConflict(value: unknown, writeId: string): void {
  if (
    isRecord(value) &&
    value.writeId === writeId &&
    Array.isArray(value.conflictRunIds) &&
    value.conflictRunIds.every((id): id is string => typeof id === "string")
  ) {
    throw new SubagentRegistryVersionConflictError(value.conflictRunIds);
  }
}

function parseAdmissionReceipt(value: unknown, writeId: string, runId: string): AdmissionReceipt {
  parseVersionConflict(value, writeId);
  if (
    !isRecord(value) ||
    value.writeId !== writeId ||
    typeof value.claimed !== "boolean" ||
    typeof value.status !== "string"
  ) {
    throw new Error("Subagent completion acknowledgment does not identify its write");
  }
  const row = parseNativeRow(value.row);
  if (row.run_id !== runId) {
    throw new Error("Subagent completion acknowledged another native owner");
  }
  return { writeId, claimed: value.claimed, status: value.status, row };
}

function parseMutationReceipt(
  value: unknown,
  writeId: string,
  runIds: readonly string[],
): MutationReceipt {
  parseVersionConflict(value, writeId);
  if (
    !isRecord(value) ||
    value.writeId !== writeId ||
    (typeof value.applied !== "boolean" && value.applied !== null) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.retiredRunIds) ||
    !Array.isArray(value.queueIds) ||
    !value.retiredRunIds.every(
      (id): id is string => typeof id === "string" && runIds.includes(id),
    ) ||
    !value.queueIds.every((id): id is string => typeof id === "string")
  ) {
    throw new Error("Subagent completion mutation acknowledgment does not identify its write");
  }
  const queueIds = value.queueIds;
  const queueReceipts = (Array.isArray(value.queueReceipts) ? value.queueReceipts : []).map(
    (receipt): SubagentCompletionQueueReceipt => {
      if (!isRecord(receipt) || typeof receipt.id !== "string" || !queueIds.includes(receipt.id)) {
        throw new Error("Subagent completion acknowledged another queue intent");
      }
      if (receipt.status === "completed" || receipt.status === "failed") {
        return { id: receipt.id, status: receipt.status };
      }
      if (
        receipt.status !== "pending" ||
        typeof receipt.enqueuedAt !== "number" ||
        !Number.isFinite(receipt.enqueuedAt) ||
        typeof receipt.payloadJson !== "string"
      ) {
        throw new Error("Subagent completion acknowledged an invalid pending queue intent");
      }
      return {
        id: receipt.id,
        status: "pending",
        enqueuedAt: receipt.enqueuedAt,
        payloadJson: receipt.payloadJson,
      };
    },
  );
  if (
    queueReceipts.length !== value.queueIds.length ||
    new Set(queueReceipts.map(({ id }) => id)).size !== queueReceipts.length
  ) {
    throw new Error("Subagent completion acknowledged incomplete queue intents");
  }
  const records = value.records.map((record) => {
    if (
      !isRecord(record) ||
      (record.cleanupHandled !== undefined && typeof record.cleanupHandled !== "boolean")
    ) {
      throw new Error("Subagent completion acknowledgment has invalid publication facts");
    }
    const row = parseNativeRow(record.row);
    if (!runIds.includes(row.run_id)) {
      throw new Error("Subagent completion acknowledged another native owner");
    }
    return { row, cleanupHandled: record.cleanupHandled };
  });
  return {
    writeId,
    applied: value.applied,
    records,
    retiredRunIds: value.retiredRunIds,
    queueIds: value.queueIds,
    ...(queueReceipts.length > 0 ? { queueReceipts } : {}),
  };
}

function hasNewerGeneration(current: SubagentRunRecord): boolean {
  return [...getSubagentRunsForChildSession(current.childSessionKey, current.childAgentId)].some(
    (candidate) => compareSubagentRunGeneration(candidate, current) > 0,
  );
}

function decodeAcknowledgedRow(row: SubagentRunSqliteRow): SubagentRunRecord {
  const record = rowToSubagentRunRecord(row);
  if (!record) {
    throw new SubagentRegistryCommitReceiptError(
      new Error("Subagent completion acknowledged an undecodable native record"),
    );
  }
  return record;
}

async function executeCompletionCommand<T>(
  context: OpenClawStateWorkerContext,
  command: CompletionCommand,
  assertCurrent: () => void,
  parse: (value: unknown) => T,
): Promise<T> {
  let admission: SqliteWorkerOperationAdmission | undefined;
  let commitGranted = false;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => parse(await scope.execute(command)),
      {
        assertCurrent,
        createAdmission: () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (
              request.facts !== command.input.writeId ||
              !(
                (phase === "waiting" && request.stage === "transaction") ||
                (phase === "transaction" && request.stage === "commit")
              )
            ) {
              throw new Error("Subagent completion write authority requested out of order");
            }
            assertCurrent();
            if (!grant()) {
              throw new Error("Subagent completion write authority expired");
            }
            phase = request.stage === "transaction" ? "transaction" : "commit";
            commitGranted = phase === "commit";
          });
          return {
            admission,
            nativeLocations: [
              context.admission.databasePath,
              context.admission.identity.canonicalPath,
            ],
          };
        },
      },
    );
  } catch (error) {
    const committed = admission?.committed;
    if (!committed) {
      if (
        error instanceof SubagentRegistryVersionConflictError ||
        error instanceof SubagentRegistryWriteError
      ) {
        throw error;
      }
      throw new SubagentRegistryWriteError(
        commitGranted || hasSqliteWorkerOutcomeUnknown(error) ? "unknown" : "not-committed",
        error,
      );
    }
    // Broker failure joins native settlement; a lost reply cannot revoke committed work.
    try {
      return parse(committed.facts);
    } catch (receiptError) {
      throw new SubagentRegistryCommitReceiptError(receiptError);
    }
  }
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
      async commit(planned, versions, authority) {
        const input = structuredClone({
          writeId: randomUUID(),
          expected: planned.expected,
          subagent: planned.subagent,
          queueEntry: planned.queueEntry,
          versions: [...versions].map(([runId, version]) => ({ runId, version })),
        });
        const receipt = await executeCompletionCommand(
          params.context,
          { type: "sessionDelivery.admitSubagentCompletion", input },
          authority.assertCurrent,
          (value) => parseAdmissionReceipt(value, input.writeId, params.runId),
        );
        const subagent = decodeAcknowledgedRow(receipt.row);
        subagent.cleanupHandled = planned.expected.cleanupHandled;
        return {
          value: {
            id: planned.queueEntry.id,
            claimed: receipt.claimed,
            status: receipt.status,
            subagent,
          },
          postimages: new Map([[params.runId, subagent]]),
          versions: new Map([[params.runId, subagentRunRowVersion(receipt.row)]]),
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

function currentCompletionOwner(
  rows: ReadonlyMap<string, SubagentRunRecord>,
  expected: SubagentRunRecord,
): SubagentRunRecord {
  const current = rows.get(expected.runId);
  if (
    !current ||
    !isSameSubagentRunOwner(current, expected) ||
    !isDeepStrictEqual(
      captureRequesterSettleRunIdentity(current),
      captureRequesterSettleRunIdentity(expected),
    ) ||
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
    current.terminalOwner !== expected.terminalOwner ||
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
    onPublished?: () => void;
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
        queueIds: string[];
        receiptRetentionFailure?: { error: unknown };
      } = { applied: null, queueIds: [] };
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
        options.onPublished?.();
      },
      async commit(planned, versions, authority) {
        const input = structuredClone({
          writeId: randomUUID(),
          mutation: planned.mutation,
          versions: [...versions].map(([runId, version]) => ({ runId, version })),
        });
        const receipt = await executeCompletionCommand(
          context,
          { type: "sessionDelivery.mutateSubagentCompletion", input },
          authority.assertCurrent,
          (value) => parseMutationReceipt(value, input.writeId, runIds),
        );
        const postimages = new Map<string, SubagentRunRecord | null>();
        for (const runId of receipt.retiredRunIds) {
          postimages.set(runId, null);
        }
        for (const native of receipt.records) {
          const record = decodeAcknowledgedRow(native.row);
          record.cleanupHandled = native.cleanupHandled;
          postimages.set(record.runId, record);
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
            queueIds: receipt.queueIds,
            receiptRetentionFailure,
          },
          postimages,
          versions: new Map([
            ...receipt.records.map(({ row }) => [row.run_id, subagentRunRowVersion(row)] as const),
            ...receipt.retiredRunIds.map((runId) => [runId, null] as const),
          ]),
        };
      },
    },
  );
  for (const id of result.queueIds) {
    try {
      await scheduleSessionDelivery(id, context);
    } catch (error) {
      log.warn("Subagent completion remains queued after scheduling failed", {
        queueId: id,
        error,
      });
    }
  }
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
      const subagent = structuredClone(current);
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
    params,
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
async function mutateRequesterBatch(
  members: readonly SubagentRunRecord[],
  operation:
    | { kind: "requesterBatch"; outcome: SubagentAnnounceDeliveryResult }
    | { kind: "requesterWake"; operation: RequesterWakeMutation },
  options: RequesterCompletionMutationOptions,
): Promise<CompletionMutationPublication> {
  return mutateCompletion(
    members,
    (rows) => {
      const mutation = {
        ...operation,
        entries: currentRequesterEntries(rows, members, options.committed),
        committed: options.committed,
      };
      return mutation.kind === "requesterBatch" ? { ...mutation, now: Date.now() } : mutation;
    },
    {
      ...options,
      onCommitted(result, mutation) {
        if (
          !options.committed &&
          (mutation.kind === "requesterBatch" || mutation.kind === "requesterWake")
        ) {
          options.onCommitted?.({ entries: mutation.entries, result });
        }
      },
    },
  );
}

export async function settleRequesterCompletionBatch(
  params: RequesterCompletionMutationOptions & {
    entries: readonly { subagent: SubagentRunRecord }[];
    outcome: SubagentAnnounceDeliveryResult;
    isCurrent(): boolean;
  },
): Promise<CompletionMutationPublication> {
  return mutateRequesterBatch(
    params.entries.map(({ subagent }) => subagent),
    { kind: "requesterBatch", outcome: params.outcome },
    {
      ...params,
      assertCurrent: () => {
        if (!params.isCurrent()) {
          throw new SubagentCompletionSourceChangedError(
            "Subagent completion owner changed before settlement",
          );
        }
      },
    },
  );
}

export async function mutateRequesterSettleWakeBatch(
  params: RequesterCompletionMutationOptions & {
    entries: readonly SubagentRunRecord[];
    operation: RequesterWakeMutation;
    context: OpenClawStateWorkerContext;
    assertCurrent: () => void;
    onCommitted: (write: RequesterWakeCommittedWrite) => void;
    onPublished: () => void;
  },
): Promise<CompletionMutationPublication> {
  return mutateRequesterBatch(
    params.entries,
    { kind: "requesterWake", operation: params.operation },
    params,
  );
}
