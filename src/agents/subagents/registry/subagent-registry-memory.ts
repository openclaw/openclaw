import { isDeepStrictEqual } from "node:util";
import { revokeGoalContinuationReturn } from "../../../auto-reply/reply/goal-continuation-return.js";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { prepareGatewayContextBindingOwner } from "../../../plugins/runtime/gateway-context-binding-owner.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { transferFollowupCohort } from "../completion/session-followup-cohort.js";
import {
  matchesSubagentChildSessionOwner,
  resolveSubagentChildAgentId,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  publishSubagentRunChanges,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  needsSubagentActivation,
  subagentSweepAt,
  SubagentRunWorkIndex,
} from "./subagent-registry-work-index.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  copySubagentRunRuntimeOwner,
  retainSubagentRunRuntimeOwner,
  isQueuedSubagentRunRekey,
  isSameSubagentRunOwner,
  latestSubagentRun,
  compareSubagentRunGeneration,
} from "./subagent-run-generation.js";
import {
  isSubagentRunPayloadEvicted,
  recordSubagentRunPayloadEviction,
} from "./subagent-run-payload-facts.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

function freezeValue(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    freezeValue(child);
  }
  Object.freeze(value);
}

const immutableRunFacts = new WeakMap<
  SubagentRunRecord,
  {
    sessionList: SubagentRunReadRecord;
    childAuthority: ReturnType<typeof resolveSubagentChildAuthority>;
  }
>();
/** Finished rows retain topology and ownership; selected readers load their durable payload. */
export function compactSubagentRunForMemory(entry: SubagentRunRecord): SubagentRunRecord {
  if (
    isSubagentRunPayloadEvicted(entry) ||
    needsSubagentActivation(entry) ||
    entry.delivery?.status === "pending" ||
    entry.delivery?.status === "in_progress" ||
    entry.delivery?.status === "suspended"
  ) {
    return immutableSubagentRun(entry);
  }
  const compact = copySubagentRunRuntimeOwner(entry, {
    ...entry,
    // A sliced preview can otherwise retain the entire original V8 string.
    task: Buffer.from(entry.task.slice(0, 160), "utf16le").toString("utf16le"),
    ...(entry.completion ? { completion: { ...entry.completion } } : {}),
    ...(entry.delivery ? { delivery: { ...entry.delivery } } : {}),
  });
  if (compact.completion) {
    delete compact.completion.resultText;
    delete compact.completion.fallbackResultText;
    delete compact.completion.terminalReply;
  }
  if (compact.delivery) {
    delete compact.delivery.payload;
  }
  delete compact.operatorRecoverySource;
  bindGatewayContextResolver(compact, getGatewayContextResolver(entry));
  recordSubagentRunPayloadEviction(compact, entry);
  return immutableSubagentRun(compact);
}

/** Hydrate only payload fields: the resident row still owns current lifecycle facts. */
export function restoreSubagentRunPayload(
  resident: SubagentRunRecord,
  full: SubagentRunRecord,
): SubagentRunRecord {
  if (!isSubagentRunPayloadEvicted(resident)) {
    return immutableSubagentRun(resident);
  }
  const restored = copySubagentRunRuntimeOwner(resident, {
    ...resident,
    task: full.task,
    operatorRecoverySource: full.operatorRecoverySource,
    ...(resident.delivery
      ? { delivery: { ...resident.delivery, payload: full.delivery?.payload } }
      : {}),
    ...(resident.completion
      ? {
          completion: {
            ...resident.completion,
            resultText: full.completion?.resultText,
            fallbackResultText: full.completion?.fallbackResultText,
            terminalReply: full.completion?.terminalReply,
          },
        }
      : {}),
  });
  bindGatewayContextResolver(restored, getGatewayContextResolver(resident));
  return immutableSubagentRun(restored);
}

/** A row replacement owns a new projection; retired immutable rows release theirs through GC. */
export function immutableSubagentRunSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  const prepared = immutableRunFacts.get(entry);
  if (prepared) {
    return prepared.sessionList;
  }
  prepareGatewayContextBindingOwner(entry);
  freezeSubagentRunReadRecord(entry);
  const projection = freezeSubagentRunReadRecord(projectSubagentRunForSessionList(entry));
  immutableRunFacts.set(entry, {
    sessionList: projection,
    childAuthority: resolveSubagentChildAuthority(entry),
  });
  return projection;
}

/** Recorded identity is immutable; live session/custody checks still belong at the effect. */
export function getRecordedSubagentChildAuthority(entry: SubagentRunRecord) {
  return immutableRunFacts.get(entry)?.childAuthority ?? resolveSubagentChildAuthority(entry);
}

export function immutableSubagentRun(entry: SubagentRunRecord): SubagentRunRecord {
  immutableSubagentRunSessionList(entry);
  return entry;
}

/** Registry projections contain only canonical JSON fields and owner-created containers. */
export function freezeSubagentRunReadRecord<T extends SubagentRunReadRecord>(record: T): T {
  freezeValue(record);
  return record;
}

const emptyRunBucket: readonly SubagentRunRecord[] = Object.freeze([]);

class SubagentRunIndex extends Map<string, SubagentRunRecord[]> {
  constructor(private readonly keyFor: (entry: SubagentRunRecord) => string | undefined) {
    super();
  }

  update(previous?: SubagentRunRecord, entry?: SubagentRunRecord): void {
    const previousKey = previous && this.keyFor(previous);
    const key = entry && this.keyFor(entry);
    if (previousKey && previousKey !== key) {
      const bucket = this.get(previousKey);
      const position = bucket && previous ? bucket.indexOf(previous) : -1;
      if (bucket && position >= 0) {
        bucket.splice(position, 1);
        if (bucket.length === 0) {
          this.delete(previousKey);
        }
      }
    }
    if (!key || !entry) {
      return;
    }
    const bucket = this.get(key);
    if (bucket?.length === 1 && bucket[0] === previous) {
      bucket[0] = entry;
    } else if (bucket) {
      // Replacement moves to the end, preserving the collector's last-published lookup.
      const position = previous ? bucket.indexOf(previous) : -1;
      if (position >= 0) {
        bucket.splice(position, 1);
      }
      bucket.push(entry);
    } else {
      this.set(key, [entry]);
    }
  }

  getLatest(key: string): SubagentRunRecord | undefined {
    return this.get(key)?.at(-1);
  }
}

// Preflight consults the collector lookup on every Gateway agent request, so it
// must stay O(1) regardless of retained collector records. The map subclass
// maintains the index whenever the row owner publishes a new immutable value.
const collectorsByChildSessionOwner = new SubagentRunIndex((entry) =>
  entry.collect === true ? childSessionOwnerKey(entry) : undefined,
);
const childSessionCandidatesByKey = new SubagentRunIndex((entry) => entry.childSessionKey);
const runsByChildSessionOwner = new SubagentRunIndex(childSessionOwnerKey);
const runsByRequesterSessionKey = new SubagentRunIndex((entry) => entry.requesterSessionKey);
const runsByCollectorGroupKey = new SubagentRunIndex(collectorGroupKey);
const runIndexes = [
  collectorsByChildSessionOwner,
  childSessionCandidatesByKey,
  runsByChildSessionOwner,
  runsByRequesterSessionKey,
  runsByCollectorGroupKey,
];

function childSessionOwnerKey(entry: {
  childSessionKey: string;
  childAgentId?: string;
}): string | undefined {
  const owner = resolveSubagentChildAgentId(entry);
  // Process-local index keys need no JSON encoding; the owner length keeps arbitrary child keys injective.
  return owner ? `${owner.length}:${owner}${entry.childSessionKey}` : undefined;
}

function collectorGroupKey(entry: SubagentRunRecord): string | undefined {
  if (entry.collect !== true || !entry.groupId) {
    return undefined;
  }
  return JSON.stringify([
    entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    entry.groupId,
  ]);
}

type SubagentRetirementObservation =
  | ({ entry: SubagentRunRecord; state: "selected" | "retired" } & Pick<
      SubagentRunRecord,
      "generation" | "createdAt"
    >)
  | { entry?: never; generation?: never; createdAt?: never; state: "superseded" };

type SubagentRetirementPublication = {
  key: object;
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
};

const retirementPublications = new Map<object, Set<SubagentRetirementPublication>>();

export function waitForSubagentRetirementPublication(
  observed: SubagentRunRecord,
): Promise<void> | undefined {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  const pending = retirementPublications.get(getSubagentRunRuntimeKey(entry));
  if (!pending?.size) {
    return undefined;
  }
  return Promise.all([...pending].map((publication) => publication.promise)).then(() => undefined);
}

export function hasPendingSubagentRetirementPublication(observed: SubagentRunRecord): boolean {
  const entry = getCurrentSubagentRunOwner(subagentRuns, observed) ?? observed;
  return Boolean(retirementPublications.get(getSubagentRunRuntimeKey(entry))?.size);
}

function completeRetirementPublication(publication: SubagentRetirementPublication): void {
  if (publication.settled) {
    return;
  }
  publication.settled = true;
  const pending = retirementPublications.get(publication.key);
  pending?.delete(publication);
  if (pending?.size === 0) {
    retirementPublications.delete(publication.key);
  }
  publication.resolve();
}

type CompletionAuthority = NonNullable<
  Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
>;
type CompletionCustody = {
  authority: CompletionAuthority;
  entry: SubagentRunRecord;
  stop: () => void;
};

class SubagentRunMap extends Map<string, SubagentRunRecord> {
  readLookup = new SubagentSessionReadLookup();
  readonly workIndex = new SubagentRunWorkIndex();
  private readonly completionAuthorities = new Map<object, CompletionCustody>();
  // A tombstone rejects stale callbacks without retaining closed Gateway/source contexts.
  private readonly requiredCompletionEntries = new WeakSet<object>();
  private readonly retiredCompletionEntries = new WeakSet<object>();

  retireCompletionAuthority(observed: SubagentRunRecord): void {
    const entry = this.currentValue(observed);
    revokeGoalContinuationReturn(entry);
    this.retiredCompletionEntries.add(getSubagentRunRuntimeKey(entry));
    this.releaseCompletionAuthority(entry);
  }

  isCompletionAuthorityRetired(entry: SubagentRunRecord): boolean {
    return this.retiredCompletionEntries.has(getSubagentRunRuntimeKey(entry));
  }

  private currentValue(entry: SubagentRunRecord): SubagentRunRecord {
    return getCurrentSubagentRunOwner(this, entry) ?? entry;
  }

  bindCompletionAuthority(row: SubagentRunRecord, source: CompletionAuthority) {
    const entry = this.currentValue(row);
    const key = getSubagentRunRuntimeKey(entry);
    // A committed row with captured custody stays restricted if its source expires before publication.
    this.requiredCompletionEntries.add(key);
    source.assertCurrent();
    if (
      this.retiredCompletionEntries.has(key) &&
      !isSameSubagentRunOwner(this.get(entry.runId), entry)
    ) {
      throw new Error("Subagent completion retry no longer owns its source");
    }
    this.releaseCompletionAuthority(entry);
    this.requiredCompletionEntries.add(key);
    this.retiredCompletionEntries.delete(key);
    const custody: CompletionCustody = {
      authority: source,
      entry,
      stop: () => source.signal.removeEventListener("abort", revoked),
    };
    const revoked = () => this.releaseCompletionAuthority(custody.entry);
    this.completionAuthorities.set(key, custody);
    source.signal.addEventListener("abort", revoked, { once: true });
    if (source.signal.aborted) {
      revoked();
    }
  }

  releaseCompletionAuthority(observed: SubagentRunRecord): void {
    const entry = this.currentValue(observed);
    const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(entry));
    this.completionAuthorities.delete(getSubagentRunRuntimeKey(entry));
    custody?.stop();
    custody?.authority.release();
  }

  private assertCompletionEntryCurrent(entry: SubagentRunRecord): void {
    const current =
      this.get(entry.runId) ??
      this.readLookup
        .selectRunIds(new Set([entry.swarmRunId ?? entry.runId]))
        .map((id) => this.get(id))
        .find((candidate) => candidate && isQueuedSubagentRunRekey(entry, candidate));
    if (current && !isSameSubagentRunOwner(current, entry)) {
      throw new Error("Subagent completion runtime owner is no longer active");
    }
    if (this.retiredCompletionEntries.has(getSubagentRunRuntimeKey(entry))) {
      throw new Error("Subagent completion requester store was retired");
    }
    if (
      this.requiredCompletionEntries.has(getSubagentRunRuntimeKey(entry)) &&
      !isSameSubagentRunOwner(this.get(entry.runId), entry)
    ) {
      throw new Error("Subagent completion authority is no longer active");
    }
  }

  runWithCompletionAuthority<T>(observed: SubagentRunRecord, run: () => T): T {
    const entry = this.currentValue(observed);
    this.assertCompletionEntryCurrent(entry);
    const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(entry));
    // Keep the requester's retained authority after child cancellation. Only a notice
    // without that custody uses its independently admitted cancellation caller.
    if (!custody && this.isCancellationNotice(entry)) {
      return run();
    }
    if (this.requiredCompletionEntries.has(getSubagentRunRuntimeKey(entry)) && !custody) {
      throw new Error("Subagent completion authority is no longer active");
    }
    return custody ? custody.authority.run(run) : run();
  }

  private isCancellationNotice(entry: SubagentRunRecord): boolean {
    return (
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.execution.outcome?.status === "error"
    );
  }

  runWithCompletionBatchAuthority<T>(observed: readonly SubagentRunRecord[], run: () => T): T {
    const batch = observed.map((entry) => this.currentValue(entry));
    batch.forEach((entry) => this.assertCompletionEntryCurrent(entry));
    const resultEntry = batch.find((entry) => !this.isCancellationNotice(entry));
    if (!resultEntry) {
      const sources = batch.map(
        (entry) => this.completionAuthorities.get(getSubagentRunRuntimeKey(entry))?.authority,
      );
      const first = sources[0];
      const original = first?.operatorAuthority;
      // A cancellation-only cohort can share its retained requester. Otherwise its
      // independently admitted cancellation caller still owns the notices.
      if (
        !first ||
        !original ||
        sources.some(
          (source) =>
            source?.operatorAuthority?.source !== original.source ||
            !isDeepStrictEqual(source?.operatorAuthority?.scopes, original.scopes),
        )
      ) {
        return run();
      }
      sources.forEach((source) => source?.assertCurrent());
      return first.run(run);
    }
    const firstCustody = this.completionAuthorities.get(getSubagentRunRuntimeKey(resultEntry));
    const first = firstCustody?.authority.operatorAuthority;
    // Mixed waves must still prove the cancelled member's original source is live and identical.
    // A revoked or unrelated cancellation cannot borrow a successful sibling's authority.
    for (const entry of batch) {
      const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(entry));
      if (this.requiredCompletionEntries.has(getSubagentRunRuntimeKey(entry)) && !custody) {
        throw new Error("Subagent completion authority is no longer active");
      }
      custody?.authority.assertCurrent();
      const source = custody?.authority.operatorAuthority;
      if (
        source?.source !== first?.source ||
        !isDeepStrictEqual(source?.scopes, first?.scopes) ||
        !isDeepStrictEqual(custody?.authority.scopes, firstCustody?.authority.scopes)
      ) {
        throw new Error("Subagent completion batch has incompatible operator authority");
      }
    }
    return this.runWithCompletionAuthority(resultEntry, run);
  }

  /** Committed replacement transfers custody without reviving a retired source. */
  transferCompletionAuthority(previous: SubagentRunRecord, next: SubagentRunRecord): void {
    transferFollowupCohort(previous, next);
    const previousKey = getSubagentRunRuntimeKey(previous);
    const nextKey = getSubagentRunRuntimeKey(next);
    if (this.retiredCompletionEntries.has(previousKey)) {
      this.retiredCompletionEntries.add(nextKey);
    }
    if (this.requiredCompletionEntries.has(previousKey)) {
      this.requiredCompletionEntries.add(nextKey);
    }
    const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(previous));
    if (!custody) {
      return;
    }
    this.completionAuthorities.delete(getSubagentRunRuntimeKey(previous));
    custody.entry = next;
    this.completionAuthorities.set(getSubagentRunRuntimeKey(next), custody);
  }

  /** Only acknowledged registry state retires completion custody. */
  settleCompletionAuthorities(
    committed: ReadonlyMap<string, SubagentRunRecord>,
    changedRunIds?: readonly string[],
  ): void {
    const changed = changedRunIds && new Set(changedRunIds);
    for (const { entry } of this.completionAuthorities.values()) {
      if (changed && !changed.has(entry.runId)) {
        continue;
      }
      const record = committed.get(entry.runId);
      if (
        !record ||
        !isSameSubagentRunOwner(this.get(entry.runId), entry) ||
        record.generation !== entry.generation ||
        (!record.requesterTurnRunId &&
          !record.requesterSettleWake &&
          record.pauseReason !== "sessions_yield" &&
          (record.cleanupCompletedAt !== undefined ||
            record.delivery?.status === "suspended" ||
            record.delivery?.status === "discarded" ||
            record.suppressCompletionDelivery === true))
      ) {
        this.releaseCompletionAuthority(entry);
      }
    }
  }

  /** Keep captured cancellation work; inspect current successors only at use. */
  captureRetirement(
    entry: SubagentRunRecord,
    isSuccessor: (candidate: SubagentRunRecord) => boolean,
  ) {
    const { promise, resolve } = createDeferredCore();
    const publication = {
      key: getSubagentRunRuntimeKey(entry),
      promise,
      resolve,
      settled: false,
    };
    const pending = retirementPublications.get(publication.key);
    if (pending) {
      pending.add(publication);
    } else {
      retirementPublications.set(publication.key, new Set([publication]));
    }
    // A newer row can already coexist with a specifically selected legacy task.
    const initial =
      latestSubagentRun(
        getSubagentRunsForChildSession(entry.childSessionKey, entry.childAgentId),
      ) ?? entry;
    let active = true;
    const observe = (): SubagentRetirementObservation => {
      const successor = latestSubagentRun(
        getSubagentRunsForChildSession(entry.childSessionKey, entry.childAgentId),
        (candidate) =>
          !isSameSubagentRunOwner(candidate, entry) &&
          (candidate.runId === entry.runId ||
            (compareSubagentRunGeneration(candidate, initial) >= 0 &&
              !isSameSubagentRunOwner(candidate, initial))) &&
          isSuccessor(candidate),
      );
      if (!active || successor) {
        return { state: "superseded" };
      }
      const current = getCurrentSubagentRunOwner(this, entry);
      const selected = current ?? entry;
      return {
        entry: selected,
        generation: selected.generation,
        createdAt: selected.createdAt,
        state: current ? "selected" : "retired",
      };
    };
    return {
      get observation() {
        return observe();
      },
      completePublication: () => completeRetirementPublication(publication),
      release: () => {
        active = false;
        completeRetirementPublication(publication);
      },
    };
  }

  /** Registration checks current rows; retired temporary successors need no retained fence. */
  captureRegistrationOwnership(
    childSessionKey: string,
    expectedEntry?: SubagentRunRecord,
    childAgentId?: string,
  ) {
    let active = true;
    let accepted = expectedEntry;
    const latest = () =>
      latestSubagentRun(getSubagentRunsForChildSession(childSessionKey, childAgentId));
    const initial = latest();
    const replaced = (observed: SubagentRunRecord | undefined) => {
      const current = latest();
      return current !== undefined && !isSameSubagentRunOwner(current, observed);
    };
    return {
      get superseded() {
        return accepted !== undefined && replaced(accepted);
      },
      assertCurrent: () => {
        if (!active || replaced(accepted ?? initial)) {
          throw new Error("Subagent registration owner changed during preparation");
        }
      },
      accept: (entry: SubagentRunRecord) => {
        if (!active || !matchesSubagentChildSessionOwner(entry, childSessionKey, childAgentId)) {
          throw new Error("Subagent registration owner changed before publication");
        }
        accepted = entry;
        this.commitOwnership(entry);
      },
      release: () => {
        active = false;
      },
    };
  }

  /** Publish accepted runtime ownership after the row's commit acknowledgement. */
  commitOwnership(entry: SubagentRunRecord): void {
    if (isSameSubagentRunOwner(this.get(entry.runId), entry)) {
      publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
    }
  }

  /** Notify readers after the row's committed retirement. */
  confirmRetirement(entry: SubagentRunRecord): void {
    publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  }

  private publishRuntimeOwner(previous: SubagentRunRecord, entry: SubagentRunRecord): void {
    this.transferCompletionAuthority(previous, entry);
    bindGatewayContextResolver(entry, getGatewayContextResolver(previous));
  }

  /** The row owner invokes this only after the source deletion and accepted address commit. */
  publishQueuedSubagentRunRekey(previous: SubagentRunRecord, accepted: SubagentRunRecord): void {
    const current = this.get(accepted.runId);
    if (!current || !isSameSubagentRunOwner(current, accepted)) {
      return;
    }
    if (
      !isSameSubagentRunOwner(previous, current) ||
      !isQueuedSubagentRunRekey(previous, current)
    ) {
      throw new Error("Queued subagent rekey lost its physical execution owner");
    }
    this.publishRuntimeOwner(previous, current);
  }

  override set(runId: string, entry: SubagentRunRecord): this {
    const prev = this.get(runId);
    retainSubagentRunRuntimeOwner(prev, entry);
    if (prev && prev !== entry && isSameSubagentRunOwner(prev, entry)) {
      this.publishRuntimeOwner(prev, entry);
    }
    super.set(runId, entry);
    this.readLookup.set(runId, entry);
    for (const index of runIndexes) {
      index.update(prev, entry);
    }
    this.workIndex.set(runId, entry);
    return this;
  }

  override delete(runId: string): boolean {
    this.readLookup.set(runId, undefined);
    this.workIndex.delete(runId);
    const prev = this.get(runId);
    if (prev) {
      for (const index of runIndexes) {
        index.update(prev);
      }
    }
    return super.delete(runId);
  }

  override clear(): void {
    this.forEach(revokeGoalContinuationReturn);
    for (const { entry } of this.completionAuthorities.values()) {
      this.releaseCompletionAuthority(entry);
    }
    for (const pending of retirementPublications.values()) {
      for (const publication of pending) {
        completeRetirementPublication(publication);
      }
    }
    super.clear();
    clearGatewayContextResolver(this);
    this.readLookup = new SubagentSessionReadLookup();
    for (const index of runIndexes) {
      index.clear();
    }
    this.workIndex.clear();
    publishSubagentRunChanges();
  }
}

export const subagentRuns = new SubagentRunMap();

/** Publication owns eligibility; settled history joins only when its retention is due. */
export function getSubagentSweepRuns(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  now: number,
): Iterable<SubagentRunRecord> {
  return runs instanceof SubagentRunMap
    ? runs.workIndex.sweepCandidates(now)
    : [...runs.values()].filter((entry) => subagentSweepAt(entry) <= now);
}

/** Row publication owns membership; settled history remains available to readers and retention. */
export function getSubagentActivationRuns(
  runs: ReadonlyMap<string, SubagentRunRecord>,
): Iterable<SubagentRunRecord> {
  return runs === subagentRuns
    ? subagentRuns.workIndex.activationRuns.values()
    : [...runs.values()].filter(needsSubagentActivation);
}

// Immutable row publications refresh keyed membership; full replacements invalidate it.
subscribeSubagentRunChanges("projection", ({ runIds: ids }) => {
  if (!ids) {
    subagentRuns.readLookup.invalidateSessions();
  } else {
    for (const id of ids) {
      subagentRuns.readLookup.set(id, subagentRuns.get(id));
    }
  }
});

export function getSubagentSessionReadLookup(runs: ReadonlyMap<string, SubagentRunRecord>) {
  return runs instanceof SubagentRunMap ? runs.readLookup : new SubagentSessionReadLookup(runs);
}

/** Resolve an observed physical execution through its existing queued/accepted address index. */
export function getCurrentSubagentRunOwner(
  runs: Map<string, SubagentRunRecord>,
  observed: SubagentRunRecord,
): SubagentRunRecord | undefined {
  const ids = new Set([observed.runId, observed.swarmRunId ?? observed.runId]);
  for (const id of getSubagentSessionReadLookup(runs).selectRunIds(ids)) {
    const current = runs.get(id);
    if (current && isSameSubagentRunOwner(current, observed)) {
      return current;
    }
  }
  return undefined;
}

export function getSubagentChildSessionCandidates(
  childSessionKey: string,
): readonly SubagentRunRecord[] {
  return childSessionCandidatesByKey.get(childSessionKey) ?? emptyRunBucket;
}

/** Iterate live generations for one child session without scanning the registry. */
export function getSubagentRunsForChildSession(
  childSessionKey: string,
  childAgentId?: string,
): Iterable<SubagentRunRecord> {
  const key = childSessionOwnerKey({ childSessionKey, childAgentId });
  return (key ? runsByChildSessionOwner.get(key) : undefined) ?? emptyRunBucket;
}

/** Current requester-owned generations, without restoring or scanning retained rows. */
export function getSubagentRunsForRequesterSession(
  requesterSessionKey: string,
): Iterable<SubagentRunRecord> {
  return runsByRequesterSessionKey.get(requesterSessionKey) ?? emptyRunBucket;
}

/** Iterate live collector members for one requester/group archive decision. */
export function getSubagentRunsForCollectorGroup(
  requesterSessionKey: string,
  groupId: string,
  requesterAgentId?: string,
): Iterable<[string, SubagentRunRecord]> {
  const key = JSON.stringify([requesterSessionKey, groupId]);
  // Restore can backfill agent ownership after index insertion; read the live owner.
  return (runsByCollectorGroupKey.get(key) ?? emptyRunBucket)
    .filter((entry) => entry.requesterAgentId === requesterAgentId)
    .map((entry) => [entry.runId, entry]);
}

/** Resolve a collector tombstone that reserves its child session from ordinary turns. */
export function findSwarmCollectorSession(
  childSessionKey?: string,
  childAgentId?: string,
): SubagentRunRecord | undefined {
  const key = childSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const ownerKey = childSessionOwnerKey({ childSessionKey: key, childAgentId });
  return ownerKey ? collectorsByChildSessionOwner.getLatest(ownerKey) : undefined;
}

/** Resolve the host-registered collector that authorizes a Gateway request. */
export function findAuthorizedSwarmCollectorRequest(params: {
  childSessionKey?: string;
  childAgentId?: string;
  idempotencyKey?: string;
  outputSchema?: Record<string, unknown>;
}): SubagentRunRecord | undefined {
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return undefined;
  }
  const entry = findSwarmCollectorSession(params.childSessionKey, params.childAgentId);
  if (!entry) {
    return undefined;
  }
  return entry.swarmLaunchIdempotencyKey === idempotencyKey &&
    isDeepStrictEqual(entry.outputSchema, params.outputSchema)
    ? entry
    : undefined;
}
