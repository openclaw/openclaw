import { randomUUID } from "node:crypto";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertSessionEntryCurrentAdmission } from "../../../config/sessions/session-entry-current-admission.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../../infra/sqlite-worker-operation-admission.js";
import { prepareGatewayContextBindingOwner } from "../../../plugins/runtime/gateway-context-binding-owner.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-context-binding.js";
import type { SessionStateNotice } from "../../../sessions/session-state-events.kernel.js";
import { enqueueSessionStateNotice } from "../../../sessions/session-state-notices.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunMutation } from "./subagent-registry-mutation.types.js";
import type {
  SubagentRegistryWriteAuthority,
  SubagentRunMutationOptions,
} from "./subagent-registry-persistence.types.js";
import {
  consumeFreshSubagentRegistryRows,
  publishSubagentRunsAfterAtomicStore,
  rememberRestoredSubagentRunNotification,
} from "./subagent-registry-state.js";
import {
  bindSubagentRunRecord,
  parseSubagentRegistryWriteReceipt,
  rememberSubagentRunVersion,
  subagentRunRecordVersion,
} from "./subagent-registry.store.codec.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  bindSubagentRunRuntimeKey,
  copySubagentRunRuntimeOwner,
  getSubagentRunRuntimeKey,
  getSubagentRunIdentity,
  isQueuedSubagentRunRekey,
  isSameSubagentRun,
  isSameSubagentRunOwner,
  retainSubagentRunRuntimeOwner,
} from "./subagent-run-generation.js";

type Admission = OpenClawStateWorkerContext["admission"];
type PendingRegistryWrite = {
  runIds: ReadonlySet<string>;
  admission: Admission;
  settled: ReturnType<typeof createDeferredCore<void>>;
  uncertain?: SubagentRegistryWriteError;
  killClaim?: SubagentRunRecord;
  rekeys?: Array<{
    from: string;
    to: string;
    owner: object;
    sourceIdentity: string;
    destinationIdentity: string;
  }>;
};
type RegistrySourceQueue = {
  admission: Admission;
  tails: Map<string, Promise<void>>;
  restore?: Promise<void>;
};
const pendingWrites = new Set<PendingRegistryWrite>();
const sourceQueues = new Set<RegistrySourceQueue>();

function matchesSource(owner: { admission: Admission }, admission: Admission): boolean {
  return (
    owner.admission.databasePath === admission.databasePath ||
    owner.admission.identity.canonicalPath === admission.identity.canonicalPath ||
    (owner.admission.identity.key === admission.identity.key &&
      owner.admission.identity.birthtime === admission.identity.birthtime)
  );
}

function sourceQueue(admission: Admission): RegistrySourceQueue {
  const existing = [...sourceQueues].find((queue) => matchesSource(queue, admission));
  if (existing) {
    return existing;
  }
  const queue: RegistrySourceQueue = { admission, tails: new Map() };
  sourceQueues.add(queue);
  return queue;
}

function releaseSourceQueue(queue: RegistrySourceQueue): void {
  if (!queue.restore && queue.tails.size === 0) {
    sourceQueues.delete(queue);
  }
}

/** Source custody is independent of the caller that authorized the mutation. */
export function assertSubagentRegistryWriteSourceCurrent(
  context: OpenClawStateWorkerContext,
): void {
  context.maintenanceScope?.assertAdmission();
  context.admission.assertCurrent();
  if (
    captureOpenClawStateWorkerContext().admission.identity.key !== context.admission.identity.key
  ) {
    throw new Error("Queued registry write lost its original database");
  }
}

export function assertSubagentRegistryWriteOutcomeKnown(
  runIds: readonly string[] | undefined,
  admission: Admission,
): void {
  for (const pending of pendingWrites) {
    if (
      pending.uncertain &&
      matchesSource(pending, admission) &&
      (runIds === undefined || runIds.some((runId) => pending.runIds.has(runId)))
    ) {
      throw pending.uncertain;
    }
  }
}

export function waitForPendingSubagentKillClaim(
  entry: SubagentRunRecord,
  admission: Admission,
): Promise<void> | undefined {
  assertSubagentRegistryWriteOutcomeKnown([entry.runId], admission);
  const claims = [...pendingWrites].filter(
    ({ killClaim, ...pending }) =>
      isSameSubagentRunOwner(killClaim, entry) && matchesSource(pending, admission),
  );
  return claims.length
    ? Promise.all(claims.map((claim) => claim.settled.promise)).then(() => {
        assertSubagentRegistryWriteOutcomeKnown([entry.runId], admission);
      })
    : undefined;
}

export class SubagentRegistryMutationRejectedError extends Error {
  override name = "SubagentRegistryMutationRejectedError";
}

/** Native adapters throw this only after a confirmed version conflict and rollback. */
export class SubagentRegistryVersionConflictError extends Error {
  override name = "SubagentRegistryVersionConflictError";
  constructor(readonly runIds: readonly string[]) {
    super("Subagent registry row versions changed");
  }
}

class SubagentRegistryConflictError extends Error {
  override name = "SubagentRegistryConflictError";
  constructor(
    readonly runIds: readonly string[],
    readonly attempts: number,
  ) {
    super(`Subagent registry rows changed during ${attempts} mutation attempts`);
  }
}

export class SubagentRegistryWriteError extends Error {
  constructor(
    readonly outcome: "not-committed" | "committed" | "unknown",
    cause: unknown,
    readonly publication?: "published" | "superseded",
  ) {
    let failure = cause;
    if (outcome === "unknown" && !hasSqliteWorkerOutcomeUnknown(cause)) {
      const unknown = new SqliteWorkerError(
        "Queued subagent registry write has an unknown outcome",
        "outcome-unknown",
      );
      unknown.cause = cause;
      failure = unknown;
    }
    super(`Queued subagent registry persistence failed: ${formatErrorMessage(cause)}`, {
      cause: failure,
    });
    this.name = "SubagentRegistryWriteError";
  }
}

/** Known native commit whose unreadable receipt still requires canonical restoration. */
export class SubagentRegistryCommitReceiptError extends SubagentRegistryWriteError {
  constructor(cause: unknown) {
    const unreadable = new SqliteWorkerError(
      "Committed registry receipt is unreadable",
      "outcome-unknown",
    );
    unreadable.cause = cause;
    super("committed", unreadable);
    this.name = "SubagentRegistryCommitReceiptError";
  }
}

function freezeValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeValue(child);
  }
  Object.freeze(value);
}

export function immutableSubagentRun(entry: SubagentRunRecord): SubagentRunRecord {
  prepareGatewayContextBindingOwner(entry);
  freezeValue(entry);
  return entry;
}

function publishRows(
  runs: Map<string, SubagentRunRecord>,
  postimages: ReadonlyMap<string, SubagentRunRecord | null>,
  context: OpenClawStateWorkerContext,
  versions?: ReadonlyMap<string, string | null>,
  afterInstall?: () => void,
): void {
  for (const [runId, next] of postimages) {
    if (next) {
      retainSubagentRunRuntimeOwner(runs.get(runId), next);
      const version = versions?.get(runId);
      if (version) {
        rememberSubagentRunVersion(next, version);
      }
      runs.set(runId, immutableSubagentRun(next));
    } else {
      runs.delete(runId);
    }
  }
  try {
    afterInstall?.();
  } finally {
    if (postimages.size) {
      const events: Array<() => void> = [];
      publishSubagentRunsAfterAtomicStore(
        runs,
        [...postimages.keys()],
        events,
        context.admission.databasePath,
      );
      for (const event of events) {
        event();
      }
    }
  }
}

async function refreshRows(
  runs: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.runs", scope: { kind: "ids", runIds } },
    { context, current: true },
  );
  assertSubagentRegistryWriteSourceCurrent(context);
  if (!reply?.ok || reply.type !== "subagents.runs" || reply.projection || !reply.versions) {
    throw new Error("Subagent version refresh did not return authoritative rows");
  }
  const postimages = new Map<string, SubagentRunRecord | null>();
  for (const runId of runIds) {
    const row = reply.runs.get(runId);
    if (!row && reply.versions.get(runId)) {
      throw new SubagentRegistryMutationRejectedError(
        "Subagent mutation found an unreadable durable row",
      );
    }
    postimages.set(runId, row ?? null);
  }
  publishRows(runs, postimages, context, reply.versions);
}

type SubagentRunMutationReceipt<T> = SubagentRunMutation<T> & {
  notices?: readonly SessionStateNotice[];
};

async function commitRows<T>(
  planned: SubagentRunMutation<T>,
  versions: ReadonlyMap<string, string | null>,
  context: OpenClawStateWorkerContext,
  authority: SubagentRegistryWriteAuthority,
): Promise<SubagentRunMutationReceipt<T>> {
  const postimages = new Map(
    [...(planned.postimages ?? [])].map(
      ([runId, row]) =>
        [runId, row ? copySubagentRunRuntimeOwner(row, structuredClone(row)) : null] as const,
    ),
  );
  const values = [...postimages.values()].flatMap((row) =>
    row ? [bindSubagentRunRecord(row)] : [],
  );
  const write: SubagentRegistryWrite = {
    writeId: randomUUID(),
    values,
    deleteRunIds: [...postimages].flatMap(([id, row]) => (row ? [] : [id])),
    versions: [...versions].map(([runId, version]) => ({ runId, version })),
    terminalEvents: planned.terminalEvents?.map(({ input }) => structuredClone(input)),
  };
  let commitGranted = false;
  let acknowledged = false;
  let admission: SqliteWorkerOperationAdmission | undefined;
  const decode = (value: unknown): SubagentRunMutationReceipt<T> => {
    const receipt = parseSubagentRegistryWriteReceipt(value, write);
    if ("conflictRunIds" in receipt) {
      throw new SubagentRegistryVersionConflictError(receipt.conflictRunIds);
    }
    acknowledged = true;
    // Runtime reservations are not encoded state; keep the admitted postimage intact.
    return {
      value: planned.value,
      postimages,
      versions: receipt.versions,
      notices: receipt.notices,
    };
  };
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        return decode(await scope.execute({ type: "subagents.persistChanges", input: write }));
      },
      {
        assertCurrent: authority.assertCurrent,
        createAdmission: () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          const eventPhases = new Map<number, "transaction" | "commit">();
          admission = createSqliteWorkerOperationAdmission((request, grant) => {
            const outerFacts = request.facts;
            const facts =
              isRecord(outerFacts) && outerFacts.kind === "session-entry-current"
                ? outerFacts.domainFacts
                : outerFacts;
            if (
              isRecord(facts) &&
              facts.writeId === write.writeId &&
              typeof facts.eventIndex === "number"
            ) {
              const event = planned.terminalEvents?.[facts.eventIndex];
              if (
                !event ||
                phase !== "transaction" ||
                !(
                  (request.stage === "transaction" && !eventPhases.has(facts.eventIndex)) ||
                  (request.stage === "commit" &&
                    eventPhases.get(facts.eventIndex) === "transaction")
                )
              ) {
                throw new Error("Subagent terminal event admission requested out of order");
              }
              authority.assertCurrent();
              assertSessionEntryCurrentAdmission(request, event.sessionEntryCurrent);
              if (!grant()) {
                throw new Error("Subagent terminal event admission expired");
              }
              eventPhases.set(facts.eventIndex, request.stage);
              return;
            }
            if (
              facts !== write.writeId ||
              !(
                (phase === "waiting" && request.stage === "transaction") ||
                (phase === "transaction" && request.stage === "commit")
              )
            ) {
              throw new Error("Queued registry write authority requested out of order");
            }
            authority.assertCurrent();
            if (!grant()) {
              throw new Error("Queued registry write authority expired");
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
    if (admission?.committed) {
      try {
        return decode(admission.committed.facts);
      } catch (receiptError) {
        throw new SubagentRegistryCommitReceiptError(receiptError);
      }
    }
    if (
      error instanceof SubagentRegistryVersionConflictError ||
      error instanceof SubagentRegistryWriteError
    ) {
      throw error;
    }
    throw new SubagentRegistryWriteError(
      acknowledged
        ? "committed"
        : commitGranted || hasSqliteWorkerOutcomeUnknown(error)
          ? "unknown"
          : "not-committed",
      error,
    );
  }
}

/** Reserve all rows before waiting; overlapping operations plan in FIFO publication order. */
export async function mutateSubagentRuns<P extends SubagentRunMutation<unknown>>(
  selectedRunIds: readonly string[],
  plan: (rows: ReadonlyMap<string, SubagentRunRecord>) => P,
  options: SubagentRunMutationOptions<P> = {},
): Promise<P["value"]> {
  const context = options.context ?? captureOpenClawStateWorkerContext();
  const runs = options.runs ?? subagentRuns;
  const recovery = options.gatewayRecovery;
  const recoveredRuntimeKey = recovery ? {} : undefined;
  const assertRecoveryCurrent = () => {
    if (!recovery) {
      return;
    }
    const current = runs.get(recovery.expected.runId);
    if (
      !current ||
      !isSameSubagentRunOwner(current, recovery.expected) ||
      current.execution.status !== "terminal" ||
      !current.requesterSettleWake ||
      getGatewayContextResolver(current) !== recovery.previousResolver ||
      recovery.previousResolver() !== undefined ||
      recovery.resolver() !== recovery.gateway
    ) {
      throw new SubagentRegistryMutationRejectedError("Subagent Gateway recovery owner changed");
    }
  };
  const runIds = [...new Set(selectedRunIds.map((id) => id.trim()).filter(Boolean))].toSorted();
  assertSubagentRegistryWriteOutcomeKnown(runIds, context.admission);
  const queue = sourceQueue(context.admission);
  const pending: PendingRegistryWrite = {
    runIds: new Set(runIds),
    admission: context.admission,
    settled: createDeferredCore(),
    killClaim: options.pendingKillClaim,
  };
  const predecessors = new Set<Promise<void>>(queue.restore ? [queue.restore] : []);
  for (const runId of runIds) {
    const previous = queue.tails.get(runId);
    if (previous) {
      predecessors.add(previous);
    }
    queue.tails.set(runId, pending.settled.promise);
  }
  pendingWrites.add(pending);
  const authority: SubagentRegistryWriteAuthority = {
    assertDatabase: () => assertSubagentRegistryWriteSourceCurrent(context),
    assertCurrent: () => {
      assertSubagentRegistryWriteSourceCurrent(context);
      assertSubagentRegistryWriteOutcomeKnown(runIds, context.admission);
      options.assertCurrent?.();
      assertRecoveryCurrent();
    },
  };
  let published = false;
  try {
    await Promise.all(predecessors);
    for (let attempt = 1; attempt <= 3; attempt++) {
      authority.assertCurrent();
      const rows = new Map<string, SubagentRunRecord>();
      for (const runId of runIds) {
        const entry = runs.get(runId);
        if (entry) {
          getSubagentRunRuntimeKey(entry);
          rows.set(runId, immutableSubagentRun(entry));
        }
      }
      const versions = new Map(runIds.map((id) => [id, subagentRunRecordVersion(rows.get(id))]));
      const planned = plan(rows);
      if (isPromiseLike(planned)) {
        void Promise.resolve(planned).catch(() => {});
        throw new Error("Subagent mutation plans must remain synchronous");
      }
      for (const [id, row] of planned.postimages ?? []) {
        if (!pending.runIds.has(id) || (row && row.runId !== id)) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent mutation writes an unadmitted row",
          );
        }
        if (row) {
          const current = rows.get(id);
          const key =
            recoveredRuntimeKey ??
            (current && isSameSubagentRun(current, row)
              ? getSubagentRunRuntimeKey(current)
              : getSubagentRunRuntimeKey(row));
          bindSubagentRunRuntimeKey(row, key);
        }
      }
      pending.rekeys = [...(planned.rekeys ?? [])].map(([from, to]) => {
        const source = rows.get(from);
        const destination = planned.postimages?.get(to);
        if (
          !source ||
          !destination ||
          rows.has(to) ||
          planned.postimages?.get(from) !== null ||
          !pending.runIds.has(to) ||
          !isQueuedSubagentRunRekey(source, destination) ||
          getSubagentRunRuntimeKey(source) !== getSubagentRunRuntimeKey(destination)
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Queued subagent rekey does not retain its admitted execution",
          );
        }
        return {
          from,
          to,
          owner: getSubagentRunRuntimeKey(source),
          sourceIdentity: getSubagentRunIdentity(source),
          destinationIdentity: getSubagentRunIdentity(destination),
        };
      });
      if (!options.commit && !planned.postimages?.size && !planned.terminalEvents?.length) {
        return planned.value;
      }
      let committed: SubagentRunMutationReceipt<P["value"]>;
      try {
        committed = options.commit
          ? await options.commit(planned, versions, authority)
          : await commitRows(planned, versions, context, authority);
      } catch (error) {
        if (!(error instanceof SubagentRegistryVersionConflictError)) {
          throw error;
        }
        await refreshRows(runs, runIds, context);
        if (attempt === 3) {
          throw new SubagentRegistryConflictError(error.runIds, attempt);
        }
        continue;
      }
      try {
        authority.assertDatabase();
        const postimages = committed.postimages ?? new Map<string, SubagentRunRecord | null>();
        for (const [id, row] of postimages) {
          if (!pending.runIds.has(id) || (row && row.runId !== id)) {
            throw new SubagentRegistryCommitReceiptError(
              "Registry receipt writes an unadmitted row",
            );
          }
          if (row) {
            const current = rows.get(id);
            const plannedRow = planned.postimages?.get(id);
            const key =
              recoveredRuntimeKey ??
              (plannedRow
                ? getSubagentRunRuntimeKey(plannedRow)
                : current && isSameSubagentRun(current, row)
                  ? getSubagentRunRuntimeKey(current)
                  : getSubagentRunRuntimeKey(row));
            bindSubagentRunRuntimeKey(row, key);
          }
        }
        publishRows(runs, postimages, context, committed.versions, () => {
          published = true;
          for (const notice of committed.notices ?? []) {
            enqueueSessionStateNotice(notice);
          }
          options.onPublished?.(postimages, committed.value);
        });
        return committed.value;
      } catch (error) {
        if (error instanceof SubagentRegistryCommitReceiptError) {
          throw error;
        }
        throw new SubagentRegistryWriteError(
          "committed",
          error,
          published ? "published" : "superseded",
        );
      }
    }
    throw new Error("Subagent mutation exhausted its admission loop");
  } catch (error) {
    if (
      error instanceof SubagentRegistryCommitReceiptError ||
      (hasSqliteWorkerOutcomeUnknown(error) &&
        !(error instanceof SubagentRegistryWriteError && error.outcome === "committed"))
    ) {
      pending.uncertain =
        error instanceof SubagentRegistryWriteError
          ? error
          : new SubagentRegistryWriteError("unknown", error);
    }
    throw error;
  } finally {
    pending.settled.resolve();
    for (const runId of runIds) {
      if (queue.tails.get(runId) === pending.settled.promise) {
        queue.tails.delete(runId);
      }
    }
    if (!pending.uncertain) {
      pendingWrites.delete(pending);
    }
    releaseSourceQueue(queue);
  }
}

export async function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}) {
  const context = params.context ?? captureOpenClawStateWorkerContext();
  return withSubagentRegistryRestore(context, () =>
    consumeFreshSubagentRegistryRows(context, (restored) => {
      params.assertCurrent?.();
      if (!params.mergeOnly) {
        reconcileRetiredSubagentRegistryWrites(params.runs, restored);
        for (const runId of params.runs.keys()) {
          if (!restored.has(runId)) {
            params.runs.delete(runId);
          }
        }
      }
      let added = 0;
      for (const [runId, entry] of restored) {
        if (params.mergeOnly && params.runs.has(runId)) {
          continue;
        }
        retainSubagentRunRuntimeOwner(params.runs.get(runId), entry);
        params.runs.set(runId, immutableSubagentRun(entry));
        rememberRestoredSubagentRunNotification(entry);
        subagentRuns.commitOwnership(entry);
        added += 1;
      }
      const events: Array<() => void> = [];
      publishSubagentRunsAfterAtomicStore(
        params.runs,
        undefined,
        events,
        context.admission.databasePath,
      );
      for (const event of events) {
        event();
      }
      return added;
    }),
  );
}

/** Canonical restore is exclusive with both accepted mutations and subsequent admissions. */
async function withSubagentRegistryRestore<T>(
  context: OpenClawStateWorkerContext,
  restore: () => Promise<T>,
): Promise<T> {
  const queue = sourceQueue(context.admission);
  const done = createDeferredCore();
  const previous = [...queue.tails.values(), ...(queue.restore ? [queue.restore] : [])];
  queue.restore = done.promise;
  try {
    await Promise.all(previous);
    assertSubagentRegistryWriteSourceCurrent(context);
    return await restore();
  } finally {
    if (queue.restore === done.promise) {
      queue.restore = undefined;
    }
    done.resolve();
    releaseSourceQueue(queue);
  }
}

/** A source close alone cannot clear an unknown commit; only a canonical read can. */
function reconcileRetiredSubagentRegistryWrites(
  runs: Map<string, SubagentRunRecord>,
  restored: ReadonlyMap<string, SubagentRunRecord>,
): void {
  const { admission } = captureOpenClawStateWorkerContext();
  for (const pending of pendingWrites) {
    if (!pending.uncertain || !matchesSource(pending, admission)) {
      continue;
    }
    const rekeys = (pending.rekeys ?? []).flatMap((attempted) => {
      const previous = runs.get(attempted.from);
      const accepted = restored.get(attempted.to);
      if (
        !previous ||
        !accepted ||
        restored.has(attempted.from) ||
        getSubagentRunRuntimeKey(previous) !== attempted.owner ||
        getSubagentRunIdentity(previous) !== attempted.sourceIdentity ||
        getSubagentRunIdentity(accepted) !== attempted.destinationIdentity ||
        !isQueuedSubagentRunRekey(previous, accepted)
      ) {
        return [];
      }
      bindSubagentRunRuntimeKey(accepted, attempted.owner);
      return [{ previous, accepted }];
    });
    for (const id of pending.runIds) {
      const row = restored.get(id);
      if (row) {
        retainSubagentRunRuntimeOwner(runs.get(id), row);
        runs.set(id, immutableSubagentRun(row));
      } else {
        runs.delete(id);
      }
    }
    for (const { previous, accepted } of rekeys) {
      subagentRuns.publishQueuedSubagentRunRekey(previous, accepted);
    }
    pendingWrites.delete(pending);
  }
}
