import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DeliveryQueueStoredStatus } from "../../../infra/delivery-queue-sqlite.kernel.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import type { QueuedSessionDelivery } from "../../../infra/session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "../../../infra/session-delivery-queue.worker-contract.js";
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
import {
  getSubagentRunsForChildSession,
  subagentRuns,
} from "../registry/subagent-registry-memory.js";
import {
  captureSubagentRunMutationSnapshot,
  captureSubagentRunPostimagePublication,
  SubagentRegistryWriteError,
  SubagentRegistryCommitReceiptError,
  SubagentRegistryPreimageChangedError,
  withSubagentRegistryWriteAuthority,
  type SubagentRegistryPublication,
} from "../registry/subagent-registry-persistence.js";
import { publishSubagentRunsAfterAtomicStore } from "../registry/subagent-registry-state.js";
import {
  rowToSubagentRunRecord,
  type SubagentRunSqliteRow,
} from "../registry/subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { compareSubagentRunGeneration } from "../registry/subagent-run-generation.js";
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
class SubagentCompletionSourceChangedError extends Error {}

type AdmissionReceipt =
  SessionDeliveryWorkerOperations["sessionDelivery.admitSubagentCompletion"]["output"];
type MutationReceipt = SubagentCompletionMutationResult & { writeId: string };
type CompletionCommand = {
  [Key in "sessionDelivery.admitSubagentCompletion" | "sessionDelivery.mutateSubagentCompletion"]: {
    type: Key;
    input: SessionDeliveryWorkerOperations[Key]["input"];
  };
}["sessionDelivery.admitSubagentCompletion" | "sessionDelivery.mutateSubagentCompletion"];

function replaceCommittedSubagent(subagent: SubagentRunRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    for (const key of Object.keys(live)) {
      Reflect.deleteProperty(live, key);
    }
    Object.assign(live, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
}

export function publishCommittedRecords(subagent: SubagentRunRecord, databasePath?: string): void {
  replaceCommittedSubagent(subagent);
  const events: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(subagentRuns, [subagent.runId], events, databasePath);
  events.forEach((emit) => emit());
}

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

function parseAdmissionReceipt(value: unknown, writeId: string, runId: string): AdmissionReceipt {
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

async function executeCompletionCommand<T>(
  context: OpenClawStateWorkerContext,
  command: CompletionCommand,
  assertCurrent: () => void,
  parse: (value: unknown) => T,
): Promise<T> {
  let admission: SqliteWorkerOperationAdmission | undefined;
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
      throw error;
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
  queueEntry: QueuedSessionDelivery;
  expected: SubagentRunRecord;
  subagent: SubagentRunRecord;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
}): Promise<{ claimed: boolean; status: DeliveryQueueStoredStatus; subagent: SubagentRunRecord }> {
  const input = structuredClone({
    writeId: randomUUID(),
    queueEntry: params.queueEntry,
    expected: params.expected,
    subagent: params.subagent,
  });
  const receipt = await executeCompletionCommand(
    params.context,
    { type: "sessionDelivery.admitSubagentCompletion", input },
    params.assertCurrent,
    (value) => parseAdmissionReceipt(value, input.writeId, input.subagent.runId),
  );
  const subagent = rowToSubagentRunRecord(receipt.row);
  if (!subagent) {
    throw new Error("Subagent completion acknowledged an undecodable native record");
  }
  return { claimed: receipt.claimed, status: receipt.status, subagent };
}

type CompletionMutationOptions = {
  context?: OpenClawStateWorkerContext;
  databaseOptions?: OpenClawStateDatabaseOptions;
  assertCurrent?: () => void;
};

type CompletionMutationPublication = {
  applied: boolean | null;
  publication: SubagentRegistryPublication | "unchanged";
};

async function mutateCompletion(
  entries: readonly SubagentRunRecord[],
  mutation: SubagentCompletionMutation,
  options: CompletionMutationOptions & {
    onCommitted?: (receipt: SubagentCompletionMutationResult) => void;
    onPublished?: () => void;
    retiredPreimages?: ReadonlySet<SubagentRunRecord>;
  } = {},
): Promise<CompletionMutationPublication> {
  const previous = new Map(
    entries.map((entry) => [entry, captureSubagentRunMutationSnapshot(entry)] as const),
  );
  const runIds = [...previous.values()].map((snapshot) => snapshot.runId);
  const context =
    options.context ??
    captureOpenClawStateWorkerContext({
      path: options.databaseOptions?.database?.path ?? options.databaseOptions?.path,
      env: options.databaseOptions?.env,
    });
  const input = structuredClone({ writeId: randomUUID(), mutation });
  const owner = captureSubagentRunPostimagePublication({
    runs: subagentRuns,
    previous,
    retiredPreimages: options.retiredPreimages,
    context,
    assertCurrent() {
      options.assertCurrent?.();
      for (const snapshot of previous.values()) {
        if (
          retiredCancellationEndedAt(snapshot, Date.now()) !== undefined &&
          [...getSubagentRunsForChildSession(snapshot.childSessionKey)].some(
            (candidate) => compareSubagentRunGeneration(candidate, snapshot) > 0,
          )
        ) {
          throw new SubagentCompletionSourceChangedError(
            "Subagent completion source changed during mutation",
          );
        }
      }
    },
    onPublished: options.onPublished,
    fromWorker: {
      deliveryReceipt: mutation.kind === "requesterWake" ? "retain-unchanged" : "replace",
    },
  });
  return withSubagentRegistryWriteAuthority(
    runIds,
    { context, assertCurrent: owner.assertCurrent },
    async (authority) => {
      const receipt = await executeCompletionCommand(
        context,
        { type: "sessionDelivery.mutateSubagentCompletion", input },
        authority.assertCurrent,
        (value) => parseMutationReceipt(value, input.writeId, runIds),
      );
      try {
        options.onCommitted?.(receipt);
      } catch (error) {
        throw new SubagentRegistryWriteError("committed", error);
      }
      let publication: CompletionMutationPublication["publication"] = "unchanged";
      if (receipt.applied === true) {
        let current = true;
        try {
          authority.assertCurrent();
        } catch {
          current = false;
          publication = "superseded";
        }
        if (current) {
          try {
            const postimages = new Map<SubagentRunRecord, SubagentRunRecord | null>();
            for (const entry of entries) {
              if (receipt.retiredRunIds.includes(entry.runId)) {
                postimages.set(entry, null);
                continue;
              }
              const native = receipt.records.find(({ row }) => row.run_id === entry.runId);
              const record = native && rowToSubagentRunRecord(native.row);
              if (!native || !record) {
                throw new Error(
                  "Subagent completion acknowledged an incomplete native publication",
                );
              }
              record.cleanupHandled = native.cleanupHandled;
              postimages.set(entry, record);
            }
            owner.publish(postimages);
            publication = "published";
            const changed = [
              ...receipt.records.map(({ row }) => row.run_id),
              ...receipt.retiredRunIds,
            ];
            if (changed.length) {
              const events: Array<() => void> = [];
              publishSubagentRunsAfterAtomicStore(
                subagentRuns,
                changed,
                events,
                context.admission.databasePath,
              );
              events.forEach((emit) => emit());
            }
          } catch (error) {
            if (
              !owner.published &&
              error instanceof SubagentRegistryWriteError &&
              error.publication === "superseded"
            ) {
              publication = "superseded";
            } else {
              throw new SubagentRegistryWriteError(
                "committed",
                error,
                owner.published ? "published" : undefined,
              );
            }
          }
        }
      }
      for (const id of receipt.queueIds) {
        try {
          await scheduleSessionDelivery(id, context);
        } catch (error) {
          log.warn("Subagent completion remains queued after scheduling failed", {
            queueId: id,
            error,
          });
        }
      }
      return { applied: receipt.applied, publication };
    },
  );
}

export async function settleSubagentCompletionDelivery(
  params: {
    subagent: SubagentRunRecord;
    queueId: string;
  } & CompletionMutationOptions,
): Promise<void> {
  const current = subagentRuns.get(params.subagent.runId);
  if (!current) {
    throw new Error("Subagent completion owner is unavailable");
  }
  const subagent = structuredClone(params.subagent);
  await mutateCompletion(
    [current],
    { kind: "settle", queueId: params.queueId, expected: structuredClone(current), subagent },
    params,
  );
}

export async function blockSubagentCompletionDelivery(
  params: BlockSubagentCompletionRequest & CompletionMutationOptions,
): Promise<boolean> {
  if (subagentRuns.get(params.subagent.runId) !== params.subagent) {
    return false;
  }
  if (params.storeReplaced) {
    subagentRuns.retireCompletionAuthority(params.subagent);
  }
  const {
    context: _context,
    databaseOptions: _databaseOptions,
    assertCurrent: _assertCurrent,
    ...request
  } = params;
  return (
    (
      await mutateCompletion(
        [params.subagent],
        { kind: "block", params: request, now: Date.now() },
        params,
      )
    ).applied === true
  );
}

export async function reconcileRetiredSubagentCancellation(
  expected: SubagentRunRecord,
  now: number,
): Promise<boolean | undefined> {
  const endedAt = retiredCancellationEndedAt(expected, now);
  if (endedAt === undefined || !expected.killReconciliation) {
    return undefined;
  }
  if (subagentRuns.get(expected.runId) !== expected) {
    return false;
  }
  try {
    const result = await mutateCompletion([expected], {
      kind: "reconcileCancelled",
      expected,
      now,
    });
    return result.applied ?? undefined;
  } catch (error) {
    if (
      error instanceof SubagentCompletionSourceChangedError ||
      error instanceof SubagentRegistryPreimageChangedError
    ) {
      return false;
    }
    throw error;
  }
}

export async function settleRequesterCompletionBatch(params: {
  entries: readonly { subagent: SubagentRunRecord }[];
  outcome: SubagentAnnounceDeliveryResult;
  isCurrent(): boolean;
  databaseOptions?: OpenClawStateDatabaseOptions;
  context?: OpenClawStateWorkerContext;
  committed?: RequesterWakeCommittedWrite;
  onCommitted?: (write: RequesterWakeCommittedWrite) => void;
  onPublished?: () => void;
  retiredPreimages?: ReadonlySet<SubagentRunRecord>;
}): Promise<CompletionMutationPublication> {
  const entries = params.entries.map(({ subagent }) => ({ subagent: structuredClone(subagent) }));
  return mutateCompletion(
    params.entries.map(({ subagent }) => subagent),
    {
      kind: "requesterBatch",
      entries,
      outcome: params.outcome,
      committed: params.committed,
      now: Date.now(),
    },
    {
      databaseOptions: params.databaseOptions,
      context: params.context,
      assertCurrent: () => {
        if (!params.isCurrent()) {
          throw new Error("Subagent completion owner changed before settlement");
        }
      },
      onCommitted(result) {
        if (!params.committed) {
          params.onCommitted?.({ entries, result });
        }
      },
      onPublished: params.onPublished,
      retiredPreimages: params.retiredPreimages,
    },
  );
}

/** The wake episode retains this receipt until its current host owner can adopt it. */
export async function mutateRequesterSettleWakeBatch(params: {
  entries: readonly SubagentRunRecord[];
  operation: RequesterWakeMutation;
  committed?: RequesterWakeCommittedWrite;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  onCommitted: (write: RequesterWakeCommittedWrite) => void;
  onPublished: () => void;
  retiredPreimages: ReadonlySet<SubagentRunRecord>;
}): Promise<CompletionMutationPublication> {
  const entries = params.entries.map((subagent) => ({ subagent: structuredClone(subagent) }));
  return mutateCompletion(
    params.entries,
    {
      kind: "requesterWake",
      entries,
      operation: params.operation,
      committed: params.committed,
    },
    {
      context: params.context,
      assertCurrent: params.assertCurrent,
      onCommitted(result) {
        if (!params.committed) {
          params.onCommitted({ entries, result });
        }
      },
      onPublished: params.onPublished,
      retiredPreimages: params.retiredPreimages,
    },
  );
}
