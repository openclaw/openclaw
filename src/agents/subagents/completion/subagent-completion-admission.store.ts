import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import { withSubagentRegistryWriteAuthority } from "../registry/subagent-registry-persistence.js";
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
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
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
    return parse(committed.facts);
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
  databaseOptions?: OpenClawStateDatabaseOptions;
  assertCurrent?: () => void;
};

async function mutateCompletion(
  entries: readonly SubagentRunRecord[],
  mutation: SubagentCompletionMutation,
  options: CompletionMutationOptions = {},
): Promise<boolean | null> {
  const selected = entries.map((entry) => ({ entry, snapshot: structuredClone(entry) }));
  const runIds = selected.map(({ snapshot }) => snapshot.runId);
  const context = captureOpenClawStateWorkerContext({
    path: options.databaseOptions?.database?.path ?? options.databaseOptions?.path,
    env: options.databaseOptions?.env,
  });
  const input = structuredClone({ writeId: randomUUID(), mutation });
  const sourceIsCurrent = () =>
    selected.every(
      ({ entry, snapshot }) =>
        subagentRuns.get(snapshot.runId) === entry &&
        isDeepStrictEqual(entry, snapshot) &&
        (retiredCancellationEndedAt(snapshot, Date.now()) === undefined ||
          ![...getSubagentRunsForChildSession(snapshot.childSessionKey)].some(
            (candidate) => compareSubagentRunGeneration(candidate, snapshot) > 0,
          )),
    );
  return withSubagentRegistryWriteAuthority(
    runIds,
    {
      context,
      assertCurrent: () => {
        options.assertCurrent?.();
        if (!sourceIsCurrent()) {
          throw new SubagentCompletionSourceChangedError(
            "Subagent completion source changed during mutation",
          );
        }
      },
    },
    async (authority) => {
      const receipt = await executeCompletionCommand(
        context,
        { type: "sessionDelivery.mutateSubagentCompletion", input },
        authority.assertCurrent,
        (value) => parseMutationReceipt(value, input.writeId, runIds),
      );
      try {
        authority.assertDatabase();
        options.assertCurrent?.();
      } catch {
        return receipt.applied;
      }
      if (
        receipt.applied === true &&
        authority.currentRunIds().length === runIds.length &&
        sourceIsCurrent()
      ) {
        const changed = [...receipt.records.map(({ row }) => row.run_id), ...receipt.retiredRunIds];
        const records = receipt.records.map(({ row, cleanupHandled }) => {
          const record = rowToSubagentRunRecord(row);
          if (!record) {
            throw new Error("Subagent completion acknowledged an undecodable native record");
          }
          record.cleanupHandled = cleanupHandled;
          return record;
        });
        records.forEach(replaceCommittedSubagent);
        receipt.retiredRunIds.forEach((id) => subagentRuns.delete(id));
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
      return receipt.applied;
    },
  );
}

export async function settleSubagentCompletionDelivery(
  params: {
    subagent: SubagentRunRecord;
  } & CompletionMutationOptions,
): Promise<void> {
  const current = subagentRuns.get(params.subagent.runId);
  if (!current) {
    throw new Error("Subagent completion owner is unavailable");
  }
  const subagent = structuredClone(params.subagent);
  await mutateCompletion(
    [current],
    { kind: "settle", expected: structuredClone(current), subagent },
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
  const { databaseOptions: _databaseOptions, assertCurrent: _assertCurrent, ...request } = params;
  return (
    (await mutateCompletion(
      [params.subagent],
      { kind: "block", params: request, now: Date.now() },
      params,
    )) === true
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
    return result ?? undefined;
  } catch (error) {
    if (error instanceof SubagentCompletionSourceChangedError) {
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
}): Promise<void> {
  await mutateCompletion(
    params.entries.map(({ subagent }) => subagent),
    {
      kind: "requesterBatch",
      entries: params.entries,
      outcome: params.outcome,
      now: Date.now(),
    },
    {
      databaseOptions: params.databaseOptions,
      assertCurrent: () => {
        if (!params.isCurrent()) {
          throw new Error("Subagent completion owner changed before settlement");
        }
      },
    },
  );
}
