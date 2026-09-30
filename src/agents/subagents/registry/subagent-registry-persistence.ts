import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
} from "../../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import {
  bindCapturedSubagentRunRecord,
  bindSubagentRunRecord,
  rowToSubagentRunRecord,
} from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PendingRegistryWrite = {
  runIds: Set<string>;
  superseded: Set<string>;
  admission: OpenClawStateWorkerContext["admission"];
  uncertain?: SubagentRegistryWriteError;
  retired?: boolean;
  unregister?: () => void;
  settled: ReturnType<typeof createDeferredCore<void>>;
  killClaim?: SubagentRunRecord;
};
const pendingWrites = new Set<PendingRegistryWrite>();

/** Source custody is independent of the caller admission that authorized a new Stop. */
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

export function waitForPendingSubagentKillClaim(
  entry: SubagentRunRecord,
  admission: OpenClawStateWorkerContext["admission"],
): Promise<void> | undefined {
  assertSubagentRegistryWriteOutcomeKnown([entry.runId], admission);
  for (const pending of pendingWrites) {
    if (pending.killClaim === entry && matchesSource(pending, admission)) {
      return pending.settled.promise;
    }
  }
  return undefined;
}

/** Joins only the already-admitted writes for the selected physical source and rows. */
export function waitForPendingSubagentRegistryWrites(
  runIds: readonly string[],
  admission: OpenClawStateWorkerContext["admission"],
): Promise<void> | undefined {
  assertSubagentRegistryWriteOutcomeKnown(runIds, admission);
  const writes = [...pendingWrites].filter(
    (pending) => matchesSource(pending, admission) && runIds.some((id) => pending.runIds.has(id)),
  );
  return writes.length > 0
    ? Promise.all(writes.map((pending) => pending.settled.promise)).then(() => undefined)
    : undefined;
}

function matchesSource(
  owner: PendingRegistryWrite,
  admission: OpenClawStateWorkerContext["admission"],
): boolean {
  return (
    owner.admission.databasePath === admission.databasePath ||
    owner.admission.identity.canonicalPath === admission.identity.canonicalPath ||
    (owner.admission.identity.key === admission.identity.key &&
      owner.admission.identity.birthtime === admission.identity.birthtime)
  );
}

export function assertSubagentRegistryWriteOutcomeKnown(
  runIds: readonly string[] | undefined,
  admission: OpenClawStateWorkerContext["admission"],
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

/** Closing a source does not reconcile a possibly committed row; a canonical restore does. */
export function reconcileRetiredSubagentRegistryWrites(
  runs: Map<string, SubagentRunRecord>,
  restored: ReadonlyMap<string, SubagentRunRecord>,
): void {
  const { admission } = captureOpenClawStateWorkerContext();
  for (const pending of pendingWrites) {
    if (!pending.retired || !pending.uncertain || !matchesSource(pending, admission)) {
      continue;
    }
    for (const runId of pending.runIds) {
      const canonical = restored.get(runId);
      if (canonical) {
        runs.set(runId, canonical);
      } else {
        runs.delete(runId);
      }
    }
    pending.unregister?.();
    pendingWrites.delete(pending);
  }
}

/** Synchronous writers invalidate pending row authority before waiting for their write lock. */
export function supersedePendingSubagentRegistryWrites(runIds?: readonly string[]): void {
  if (pendingWrites.size === 0) {
    return;
  }
  const { admission } = captureOpenClawStateWorkerContext();
  assertSubagentRegistryWriteOutcomeKnown(runIds, admission);
  for (const pending of pendingWrites) {
    if (!matchesSource(pending, admission)) {
      continue;
    }
    for (const runId of runIds ?? pending.runIds) {
      if (pending.runIds.has(runId)) {
        pending.superseded.add(runId);
      }
    }
  }
}

export type SubagentRegistryPublication = "published" | "superseded";

export class SubagentRegistryPreimageChangedError extends Error {}

export class SubagentRegistryWriteError extends Error {
  constructor(
    readonly outcome: "not-committed" | "committed" | "unknown",
    cause: unknown,
    readonly publication?: SubagentRegistryPublication,
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

/** Native commit is known, but only canonical restoration can recover its unreadable facts. */
export class SubagentRegistryCommitReceiptError extends SubagentRegistryWriteError {
  constructor(cause: unknown) {
    // Preserve existing restore-only error handling without losing the known native commit.
    const unreadable = new SqliteWorkerError(
      "Committed registry receipt is unreadable",
      "outcome-unknown",
    );
    unreadable.cause = cause;
    super("committed", unreadable);
    this.name = "SubagentRegistryCommitReceiptError";
  }
}

export type SubagentRegistryWriteOptions = {
  context: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
  onCommitted?: () => void;
  retireRunIds?: readonly string[];
  pendingKillClaim?: SubagentRunRecord;
};

type SubagentRegistryWriteAuthority = {
  assertCurrent: () => void;
  assertDatabase: () => void;
  currentRunIds: () => string[];
};

/** All registry writers retain the same pending-write supersession owner through settlement. */
export async function withSubagentRegistryWriteAuthority<T>(
  runIds: readonly string[],
  options: SubagentRegistryWriteOptions,
  run: (authority: SubagentRegistryWriteAuthority) => Promise<T>,
): Promise<T> {
  const { context } = options;
  assertSubagentRegistryWriteOutcomeKnown(runIds, context.admission);
  const pending: PendingRegistryWrite = {
    runIds: new Set(runIds),
    superseded: new Set(),
    admission: context.admission,
    settled: createDeferredCore(),
    killClaim: options.pendingKillClaim,
  };
  // A waiter may not exist; the actual mutation caller still owns the same rejection.
  void pending.settled.promise.catch(() => {});
  const assertDatabase = () => assertSubagentRegistryWriteSourceCurrent(context);
  const assertCurrent = () => {
    assertDatabase();
    assertSubagentRegistryWriteOutcomeKnown(runIds, context.admission);
    options.assertCurrent?.();
    if (pending.superseded.size > 0) {
      throw new Error("Queued registry write was superseded");
    }
  };
  pendingWrites.add(pending);
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    close: async (identity) => {
      if (!identity || identity.key === context.admission.identity.key) {
        pending.retired = true;
      }
    },
  });
  pending.unregister = unregister;
  try {
    return await run({
      assertCurrent,
      assertDatabase,
      currentRunIds: () => runIds.filter((runId) => !pending.superseded.has(runId)),
    });
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
    if (pending.uncertain) {
      pending.settled.reject(pending.uncertain);
    } else {
      pending.settled.resolve();
    }
    if (!pending.uncertain) {
      unregister();
      pendingWrites.delete(pending);
    }
  }
}

/** Retains captured rows, original database admission, and publication through actor settlement. */
export async function persistSubagentRegistryChangesAsync(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  options: SubagentRegistryWriteOptions,
  publish: (snapshot: Map<string, SubagentRunRecord>, runIds: readonly string[]) => void,
): Promise<void> {
  const runIds = [...new Set(changedRunIds.map((id) => id.trim()).filter(Boolean))];
  const retired = new Set(options.retireRunIds);
  return withSubagentRegistryWriteAuthority(runIds, options, async (authority) => {
    let commitGranted = false;
    let acknowledged = false;
    try {
      const snapshot = new Map<string, SubagentRunRecord>();
      for (const runId of runIds) {
        const entry = runs.get(runId);
        if (entry && !retired.has(runId)) {
          snapshot.set(runId, normalizeSubagentRunState(structuredClone(entry)));
        }
      }
      const write = {
        writeId: randomUUID(),
        values: [...snapshot.values()].map(bindCapturedSubagentRunRecord),
        deleteRunIds: runIds.filter((runId) => !snapshot.has(runId)),
      };
      const { context } = options;
      await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          const receipt = await scope.execute({ type: "subagents.persistChanges", input: write });
          if (receipt.writeId !== write.writeId) {
            throw new Error("Queued registry acknowledgement identifies another write");
          }
          acknowledged = true;
          try {
            authority.assertDatabase();
          } catch (error) {
            throw new SubagentRegistryWriteError("committed", error, "superseded");
          }
          const currentIds = authority.currentRunIds();
          if (currentIds.length > 0) {
            publish(snapshot, currentIds);
          }
        },
        {
          assertCurrent: authority.assertCurrent,
          createAdmission: () => {
            let phase: "waiting" | "transaction" | "commit" = "waiting";
            return {
              nativeLocations: [
                context.admission.databasePath,
                context.admission.identity.canonicalPath,
              ],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                if (
                  request.facts !== write.writeId ||
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
              }),
            };
          },
        },
      );
    } catch (error) {
      if (acknowledged && error instanceof SubagentRegistryWriteError) {
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
  });
}

/** Keep the live pointers that identify execution and cancellation owners during staging. */
export function captureSubagentRunMutationSnapshot(entry: SubagentRunRecord): SubagentRunRecord {
  const snapshot = structuredClone(entry);
  snapshot.execution = entry.execution;
  // Announcements retain this immutable fact while unrelated completion fields are staged.
  if (snapshot.completion && entry.completion?.terminalReply) {
    snapshot.completion.terminalReply = entry.completion.terminalReply;
  }
  // An absent optional owner must remain absent for exact preimage comparison.
  if (Object.hasOwn(entry, "killIntent")) {
    snapshot.killIntent = entry.killIntent;
  }
  if (Object.hasOwn(entry, "killReconciliation")) {
    snapshot.killReconciliation = entry.killReconciliation;
  }
  if (Object.hasOwn(entry, "requesterSettleWake")) {
    snapshot.requesterSettleWake = entry.requesterSettleWake;
  }
  return snapshot;
}

export type SubagentRegistryPostimageResult = {
  outcome: "committed";
  publication: SubagentRegistryPublication;
};

function replaceSubagentRunRecord(entry: SubagentRunRecord, value: SubagentRunRecord): void {
  for (const key of Object.keys(entry)) {
    Reflect.deleteProperty(entry, key);
  }
  Object.assign(entry, value);
}

function matchesSubagentRunPreimages(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  previous: ReadonlyMap<SubagentRunRecord, SubagentRunRecord | undefined>,
  retired?: ReadonlySet<SubagentRunRecord>,
): boolean {
  return [...previous].every(([entry, snapshot]) =>
    snapshot === undefined
      ? !runs.has(entry.runId)
      : runs.get(snapshot.runId) === (retired?.has(entry) ? undefined : entry) &&
        isDeepStrictEqual(entry, snapshot),
  );
}

function retainUnchangedSubagentOwners(
  previous: SubagentRunRecord,
  next: SubagentRunRecord,
  runtime: {
    terminalReply: NonNullable<SubagentRunRecord["completion"]>["terminalReply"];
    delivery: SubagentRunRecord["delivery"];
  },
  retainDeliveryReceipt: boolean,
): SubagentRunRecord {
  const canonical = rowToSubagentRunRecord(bindSubagentRunRecord(previous));
  if (!canonical) {
    throw new Error("Subagent publication has an invalid preimage");
  }
  const retain = <
    K extends "execution" | "killIntent" | "killReconciliation" | "requesterSettleWake",
  >(
    key: K,
  ): SubagentRunRecord[K] =>
    isDeepStrictEqual(canonical[key], next[key]) ? previous[key] : next[key];
  return {
    ...next,
    ...(runtime.terminalReply &&
    next.completion &&
    isDeepStrictEqual(canonical.completion?.terminalReply, next.completion.terminalReply)
      ? { completion: { ...next.completion, terminalReply: runtime.terminalReply } }
      : {}),
    delivery:
      retainDeliveryReceipt &&
      runtime.delivery &&
      isDeepStrictEqual(canonical.delivery, next.delivery)
        ? runtime.delivery
        : next.delivery,
    execution: retain("execution"),
    killIntent: retain("killIntent"),
    killReconciliation: retain("killReconciliation"),
    requesterSettleWake: retain("requesterSettleWake"),
  };
}

/** Native receipts and staged writes publish through the same live preimage authority. */
export function captureSubagentRunPostimagePublication(params: {
  runs: Map<string, SubagentRunRecord>;
  previous: ReadonlyMap<SubagentRunRecord, SubagentRunRecord | undefined>;
  /** Already published native retirements, retained by their original receipt owner. */
  retiredPreimages?: ReadonlySet<SubagentRunRecord>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  onPublished?: () => void;
  fromWorker?: { deliveryReceipt: "retain-unchanged" | "replace" };
  requireMutationOwnerIdentity?: true;
}) {
  const originals = new Map(params.previous);
  // Findings and cleanup retain these identities independently of staged field snapshots.
  const runtimeOwners = new Map(
    [...originals.keys()].map(
      (entry) =>
        [
          entry,
          {
            execution: entry.execution,
            killIntent: entry.killIntent,
            killReconciliation: entry.killReconciliation,
            requesterSettleWake: entry.requesterSettleWake,
            terminalReply: entry.completion?.terminalReply,
            delivery: entry.delivery,
          },
        ] as const,
    ),
  );
  const retired = new Set(params.retiredPreimages);
  const snapshots = new Map(
    [...originals].map(([entry, previous]) => [entry, structuredClone(previous)] as const),
  );
  let published = false;
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(params.context);
    params.assertCurrent();
    if (
      !matchesSubagentRunPreimages(params.runs, snapshots, retired) ||
      ((params.fromWorker || params.requireMutationOwnerIdentity) &&
        [...runtimeOwners].some(
          ([entry, owner]) =>
            entry.execution !== owner.execution ||
            entry.killIntent !== owner.killIntent ||
            entry.killReconciliation !== owner.killReconciliation ||
            entry.requesterSettleWake !== owner.requesterSettleWake ||
            (params.fromWorker &&
              (entry.completion?.terminalReply !== owner.terminalReply ||
                entry.delivery !== owner.delivery)),
        ))
    ) {
      throw new SubagentRegistryPreimageChangedError(
        "Subagent publication lost its original preimage",
      );
    }
  };
  return {
    assertCurrent,
    get published() {
      return published;
    },
    publish(postimages: ReadonlyMap<SubagentRunRecord, SubagentRunRecord | null>): void {
      if (
        postimages.size !== snapshots.size ||
        [...snapshots.keys()].some((entry) => !postimages.has(entry))
      ) {
        throw new SubagentRegistryWriteError(
          "committed",
          new Error("Subagent publication does not cover its captured rows"),
        );
      }
      try {
        assertCurrent();
      } catch (error) {
        throw new SubagentRegistryWriteError("committed", error, "superseded");
      }
      // Prepare all records before installing any row; decoding failure is not partial publication.
      const selected = [...postimages].map(([entry, next]) => {
        const previous = originals.get(entry);
        return {
          entry,
          next:
            next && params.fromWorker && previous
              ? retainUnchangedSubagentOwners(
                  previous,
                  next,
                  runtimeOwners.get(entry)!,
                  params.fromWorker.deliveryReceipt === "retain-unchanged",
                )
              : next,
        };
      });
      for (const { entry, next } of selected) {
        if (next === null) {
          params.runs.delete(entry.runId);
        } else {
          replaceSubagentRunRecord(entry, next);
          if (!originals.get(entry)) {
            params.runs.set(entry.runId, entry);
          }
        }
      }
      published = true;
      params.onPublished?.();
    },
  };
}

/** The existing writer captures staged rows synchronously; live preimages remain until ACK. */
export async function publishSubagentRunPostimages(params: {
  runs: Map<string, SubagentRunRecord>;
  /** An undefined preimage registers a new row without exposing it before ACK. */
  previous: ReadonlyMap<SubagentRunRecord, SubagentRunRecord | undefined>;
  retire?: ReadonlySet<SubagentRunRecord>;
  pendingKillClaim?: SubagentRunRecord;
  persist: (
    context: OpenClawStateWorkerContext,
    callbacks: Omit<SubagentRegistryWriteOptions, "context"> & { assertCurrent: () => void },
    ...runIds: string[]
  ) => Promise<void>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  /** An acknowledged native mutation can retain target custody after its caller retires. */
  assertPublicationCurrent?: () => void;
  onPublished?: () => void;
}): Promise<SubagentRegistryPostimageResult> {
  const selected = [...params.previous].map(([entry, previous]) => ({
    entry,
    previous,
    next: { ...entry },
    retire: params.retire?.has(entry) === true,
  }));
  const previousSnapshots = new Map(
    selected.map(({ entry, previous }) => [entry, structuredClone(previous)] as const),
  );
  const nextSnapshots = new Map(
    selected.map(({ entry, next }) => [entry, structuredClone(next)] as const),
  );
  const postimages = new Map(
    selected.map(({ entry, next, retire }) => [entry, retire ? null : next] as const),
  );
  const owner = captureSubagentRunPostimagePublication({
    ...params,
    assertCurrent: params.assertPublicationCurrent ?? params.assertCurrent,
  });
  let capturing = true;
  let publication: Promise<void>;
  try {
    params.assertCurrent();
    publication = params.persist(
      params.context,
      {
        pendingKillClaim: params.pendingKillClaim,
        retireRunIds: selected.filter(({ retire }) => retire).map(({ entry }) => entry.runId),
        assertCurrent() {
          params.assertCurrent();
          const expected = capturing ? nextSnapshots : previousSnapshots;
          if (!matchesSubagentRunPreimages(params.runs, expected)) {
            throw new Error("Subagent mutation lost its original registry row");
          }
        },
        onCommitted() {
          owner.publish(postimages);
        },
      },
      ...selected.map(({ entry }) => entry.runId),
    );
  } finally {
    // Registration hides its provisional row even if an older tombstone changed during capture.
    const registration = selected.some((selection) => selection.previous === undefined);
    if (registration || matchesSubagentRunPreimages(params.runs, nextSnapshots)) {
      for (const selection of selected) {
        if (
          registration &&
          (params.runs.get(selection.entry.runId) !== selection.entry ||
            !isDeepStrictEqual(selection.entry, nextSnapshots.get(selection.entry)))
        ) {
          continue;
        }
        if (selection.previous) {
          replaceSubagentRunRecord(selection.entry, selection.previous);
        } else {
          params.runs.delete(selection.entry.runId);
        }
      }
    }
    capturing = false;
  }
  try {
    await publication;
  } catch (error) {
    if (error instanceof SubagentRegistryWriteError && error.outcome === "committed") {
      if (!owner.published && error.publication === "superseded") {
        return { outcome: "committed", publication: "superseded" };
      }
      throw new SubagentRegistryWriteError(
        "committed",
        error,
        owner.published ? "published" : error.publication,
      );
    }
    throw error;
  }
  return { outcome: "committed", publication: owner.published ? "published" : "superseded" };
}
