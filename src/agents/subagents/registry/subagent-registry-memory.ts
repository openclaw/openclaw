import { isDeepStrictEqual } from "node:util";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { prepareGatewayContextBindingOwner } from "../../../plugins/runtime/gateway-context-binding-owner.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { transferFollowupCohort } from "../completion/session-followup-cohort.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  publishSubagentRunChanges,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  retainSubagentRunRuntimeOwner,
  isQueuedSubagentRunRekey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";
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

export function immutableSubagentRun(entry: SubagentRunRecord): SubagentRunRecord {
  prepareGatewayContextBindingOwner(entry);
  return freezeSubagentRunReadRecord(entry);
}

/** Registry projections contain only canonical JSON fields and owner-created containers. */
export function freezeSubagentRunReadRecord<T extends SubagentRunReadRecord>(record: T): T {
  freezeValue(record);
  return record;
}

// Preflight consults the collector lookup on every Gateway agent request, so it
// must stay O(1) regardless of retained collector records. The map subclass
// maintains the index whenever the row owner publishes a new immutable value.
const collectorRunIdByChildSessionKey = new Map<string, string>();
const runsByChildSessionKey = new Map<string, Map<string, SubagentRunRecord>>();
const runsByRequesterSessionKey = new Map<string, Map<string, SubagentRunRecord>>();
const runsByCollectorGroupKey = new Map<string, Map<string, SubagentRunRecord>>();

function collectorGroupKey(entry: SubagentRunRecord): string | undefined {
  if (entry.collect !== true || !entry.groupId) {
    return undefined;
  }
  return JSON.stringify([
    entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    entry.groupId,
  ]);
}

function removeIndexedSubagentRun(
  index: Map<string, Map<string, SubagentRunRecord>>,
  key: string | undefined,
  runId: string,
  entry: SubagentRunRecord,
) {
  if (!key) {
    return;
  }
  const indexedRuns = index.get(key);
  if (indexedRuns?.get(runId) !== entry) {
    return;
  }
  indexedRuns.delete(runId);
  if (indexedRuns.size === 0) {
    index.delete(key);
  }
}

function indexSubagentRun(
  index: Map<string, Map<string, SubagentRunRecord>>,
  key: string | undefined,
  runId: string,
  entry: SubagentRunRecord,
) {
  if (!key) {
    return;
  }
  const indexedRuns = index.get(key);
  if (indexedRuns) {
    indexedRuns.set(runId, entry);
  } else {
    index.set(key, new Map([[runId, entry]]));
  }
}

type SubagentRetirementScope = {
  observation:
    | ({ entry: SubagentRunRecord; state: "selected" | "retired" } & Pick<
        SubagentRunRecord,
        "generation" | "createdAt"
      >)
    | { entry?: never; generation?: never; createdAt?: never; state: "superseded" };
  isSuccessor: (candidate: SubagentRunRecord) => boolean;
  publication: {
    entry: SubagentRunRecord;
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
  };
};

const retirementPublications = new WeakMap<object, Set<SubagentRetirementScope["publication"]>>();

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

function completeRetirementPublication(scope: SubagentRetirementScope): void {
  const publication = scope.publication;
  if (publication.settled) {
    return;
  }
  publication.settled = true;
  const pending = retirementPublications.get(getSubagentRunRuntimeKey(publication.entry));
  pending?.delete(publication);
  if (pending?.size === 0) {
    retirementPublications.delete(getSubagentRunRuntimeKey(publication.entry));
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
  private readonly retirementScopes = new Set<SubagentRetirementScope>();
  private readonly registrationScopes = new Set<{
    childSessionKey: string;
    childAgentId?: string;
    current: boolean;
    superseded: boolean;
    expectedEntry?: SubagentRunRecord;
  }>();
  private readonly completionAuthorities = new Map<object, CompletionCustody>();
  // A tombstone rejects stale callbacks without retaining closed Gateway/source contexts.
  private readonly operatorCompletionEntries = new WeakSet<object>();
  private readonly retiredCompletionEntries = new WeakSet<object>();

  retireCompletionAuthority(observed: SubagentRunRecord): void {
    const entry = this.currentValue(observed);
    this.retiredCompletionEntries.add(getSubagentRunRuntimeKey(entry));
    this.releaseCompletionAuthority(entry);
  }

  isCompletionAuthorityRetired(entry: SubagentRunRecord): boolean {
    return this.retiredCompletionEntries.has(getSubagentRunRuntimeKey(this.currentValue(entry)));
  }

  private currentValue(entry: SubagentRunRecord): SubagentRunRecord {
    return getCurrentSubagentRunOwner(this, entry) ?? entry;
  }

  bindCompletionAuthority(observed: SubagentRunRecord, authority: CompletionAuthority): void {
    const entry = this.currentValue(observed);
    // A committed operator-owned row stays restricted if its source expires before publication.
    this.operatorCompletionEntries.add(getSubagentRunRuntimeKey(entry));
    authority.assertCurrent();
    if (
      this.retiredCompletionEntries.has(getSubagentRunRuntimeKey(entry)) &&
      !isSameSubagentRunOwner(this.get(entry.runId), entry)
    ) {
      throw new Error("Subagent completion retry no longer owns its source");
    }
    this.releaseCompletionAuthority(entry);
    this.retiredCompletionEntries.delete(getSubagentRunRuntimeKey(entry));
    const custody: CompletionCustody = {
      authority,
      entry,
      stop: () => authority.signal.removeEventListener("abort", revoked),
    };
    const revoked = () => this.releaseCompletionAuthority(custody.entry);
    this.completionAuthorities.set(getSubagentRunRuntimeKey(entry), custody);
    authority.signal.addEventListener("abort", revoked, { once: true });
    if (authority.signal.aborted) {
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

  private assertCompletionEntryCurrent(observed: SubagentRunRecord): void {
    const entry = this.currentValue(observed);
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
      this.operatorCompletionEntries.has(getSubagentRunRuntimeKey(entry)) &&
      !isSameSubagentRunOwner(this.get(entry.runId), entry)
    ) {
      throw new Error("Subagent completion authority is no longer active");
    }
  }

  runWithCompletionAuthority<T>(observed: SubagentRunRecord, run: () => T): T {
    const entry = this.currentValue(observed);
    this.assertCompletionEntryCurrent(entry);
    const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(entry));
    // Cancellation notices belong to the admitted cancellation caller, not its revoked target.
    // Keep that caller's existing dispatch restrictions; never turn a successful result into a notice.
    if (
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.execution.outcome?.status === "error"
    ) {
      return run();
    }
    if (this.operatorCompletionEntries.has(getSubagentRunRuntimeKey(entry)) && !custody) {
      throw new Error("Subagent completion authority is no longer active");
    }
    return custody ? custody.authority.run(run) : run();
  }

  runWithCompletionBatchAuthority<T>(observed: readonly SubagentRunRecord[], run: () => T): T {
    const batch = observed.map((entry) => this.currentValue(entry));
    batch.forEach((entry) => this.assertCompletionEntryCurrent(entry));
    const resultEntry = batch.find(
      (entry) =>
        !(
          entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          entry.execution.outcome?.status === "error"
        ),
    );
    // Only a cancellation-only batch can use the independently admitted cancellation caller.
    if (!resultEntry) {
      return run();
    }
    const first = this.completionAuthorities.get(getSubagentRunRuntimeKey(resultEntry))?.authority
      .operatorAuthority;
    // Mixed waves must still prove the cancelled member's original source is live and identical.
    // A revoked or unrelated cancellation cannot borrow a successful sibling's authority.
    for (const entry of batch) {
      const source = this.completionAuthorities.get(getSubagentRunRuntimeKey(entry))?.authority
        .operatorAuthority;
      if (this.operatorCompletionEntries.has(getSubagentRunRuntimeKey(entry)) && !source) {
        throw new Error("Subagent completion authority is no longer active");
      }
      source?.assertCurrent();
      if (source?.source !== first?.source || !isDeepStrictEqual(source?.scopes, first?.scopes)) {
        throw new Error("Subagent completion batch has incompatible operator authority");
      }
    }
    return this.runWithCompletionAuthority(resultEntry, run);
  }

  /** Committed replacement transfers custody without reviving a retired source. */
  transferCompletionAuthority(previous: SubagentRunRecord, next: SubagentRunRecord): void {
    transferFollowupCohort(previous, next);
    if (this.retiredCompletionEntries.has(getSubagentRunRuntimeKey(previous))) {
      this.retiredCompletionEntries.add(getSubagentRunRuntimeKey(next));
    }
    if (this.operatorCompletionEntries.has(getSubagentRunRuntimeKey(previous))) {
      this.operatorCompletionEntries.add(getSubagentRunRuntimeKey(next));
    }
    const custody = this.completionAuthorities.get(getSubagentRunRuntimeKey(previous));
    if (!custody) {
      return;
    }
    this.completionAuthorities.delete(getSubagentRunRuntimeKey(previous));
    custody.entry = next;
    this.completionAuthorities.set(getSubagentRunRuntimeKey(next), custody);
    this.operatorCompletionEntries.add(getSubagentRunRuntimeKey(next));
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

  /** A cancellation borrows retirement evidence only for its own lexical lifetime. */
  captureRetirement(
    entry: SubagentRunRecord,
    isSuccessor: (candidate: SubagentRunRecord) => boolean,
  ) {
    const { promise, resolve } = createDeferredCore();
    const publication = {
      entry,
      promise,
      resolve,
      settled: false,
    };
    const scope: SubagentRetirementScope = {
      observation: {
        entry,
        generation: entry.generation,
        createdAt: entry.createdAt,
        state: "selected",
      },
      isSuccessor,
      publication,
    };
    this.retirementScopes.add(scope);
    const pending = retirementPublications.get(getSubagentRunRuntimeKey(entry));
    if (pending) {
      pending.add(publication);
    } else {
      retirementPublications.set(getSubagentRunRuntimeKey(entry), new Set([publication]));
    }
    return {
      get observation() {
        return scope.observation;
      },
      completePublication: () => completeRetirementPublication(scope),
      release: () => {
        completeRetirementPublication(scope);
        scope.observation = { state: "superseded" };
        this.retirementScopes.delete(scope);
      },
    };
  }

  /** A committed successor remains superseding even if it retires before preparation finishes. */
  captureRegistrationOwnership(
    childSessionKey: string,
    expectedEntry?: SubagentRunRecord,
    childAgentId?: string,
  ) {
    const scope = {
      childSessionKey,
      childAgentId,
      current: true,
      superseded: false,
      expectedEntry,
    };
    this.registrationScopes.add(scope);
    return {
      get superseded() {
        return scope.superseded;
      },
      assertCurrent: () => {
        if (!scope.current) {
          throw new Error("Subagent registration owner changed during preparation");
        }
      },
      accept: (entry: SubagentRunRecord) => {
        if (!scope.current || entry.childSessionKey !== childSessionKey) {
          throw new Error("Subagent registration owner changed before publication");
        }
        scope.expectedEntry = entry;
        this.commitOwnership(entry);
      },
      release: () => {
        scope.current = false;
        this.registrationScopes.delete(scope);
      },
    };
  }

  /** Publish accepted runtime ownership after the row's commit acknowledgement. */
  commitOwnership(entry: SubagentRunRecord): void {
    if (this.settleCommittedOwnership(entry)) {
      publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
    }
  }

  /** Bulk restore settles custody before its one atomic row publication notifies readers. */
  settleCommittedOwnership(entry: SubagentRunRecord): boolean {
    if (!isSameSubagentRunOwner(this.get(entry.runId), entry)) {
      return false;
    }
    for (const scope of this.registrationScopes) {
      if (
        matchesSubagentChildSessionOwner(entry, scope.childSessionKey, scope.childAgentId) &&
        !isSameSubagentRunOwner(scope.expectedEntry, entry)
      ) {
        scope.current = false;
        scope.superseded = true;
      }
    }
    for (const scope of this.retirementScopes) {
      const previous = scope.observation.entry;
      if (
        previous &&
        !isSameSubagentRunOwner(previous, entry) &&
        previous.childSessionKey === entry.childSessionKey &&
        scope.isSuccessor(entry)
      ) {
        // New work supersedes the selected execution, even if the replacement
        // is retired before the pending Stop resumes.
        scope.observation = { state: "superseded" };
      }
    }
    return true;
  }

  /** Normal cleanup calls this only after its deletion commits; raw map deletion is not evidence. */
  confirmRetirement(entry: SubagentRunRecord): void {
    for (const scope of this.retirementScopes) {
      const observed = scope.observation;
      if (
        isSameSubagentRunOwner(observed.entry, entry) &&
        observed.state === "selected" &&
        !isSameSubagentRunOwner(this.get(entry.runId), entry)
      ) {
        observed.state = "retired";
      }
    }
    publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  }

  private publishRuntimeOwner(previous: SubagentRunRecord, entry: SubagentRunRecord): void {
    this.transferCompletionAuthority(previous, entry);
    bindGatewayContextResolver(entry, getGatewayContextResolver(previous));
    const retirements = retirementPublications.get(getSubagentRunRuntimeKey(previous));
    if (retirements) {
      for (const publication of retirements) {
        publication.entry = entry;
      }
    }
    for (const scope of this.retirementScopes) {
      if (
        scope.observation.state !== "superseded" &&
        isSameSubagentRunOwner(scope.observation.entry, previous)
      ) {
        scope.observation = {
          ...scope.observation,
          entry,
          generation: entry.generation,
          createdAt: entry.createdAt,
        };
      }
    }
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
    if (prev) {
      removeIndexedSubagentRun(runsByChildSessionKey, prev.childSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByRequesterSessionKey, prev.requesterSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByCollectorGroupKey, collectorGroupKey(prev), runId, prev);
      if (prev.collect === true && prev.childSessionKey) {
        collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
      }
    }
    super.set(runId, entry);
    this.readLookup.set(runId, entry);
    indexSubagentRun(runsByChildSessionKey, entry.childSessionKey, runId, entry);
    indexSubagentRun(runsByRequesterSessionKey, entry.requesterSessionKey, runId, entry);
    indexSubagentRun(runsByCollectorGroupKey, collectorGroupKey(entry), runId, entry);
    if (entry.collect === true && entry.childSessionKey) {
      collectorRunIdByChildSessionKey.set(entry.childSessionKey, runId);
    }
    return this;
  }

  override delete(runId: string): boolean {
    this.readLookup.set(runId, undefined);
    const prev = this.get(runId);
    if (prev) {
      removeIndexedSubagentRun(runsByChildSessionKey, prev.childSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByRequesterSessionKey, prev.requesterSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByCollectorGroupKey, collectorGroupKey(prev), runId, prev);
    }
    if (
      prev?.collect === true &&
      prev.childSessionKey &&
      collectorRunIdByChildSessionKey.get(prev.childSessionKey) === runId
    ) {
      collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
    }
    return super.delete(runId);
  }

  override clear(): void {
    for (const scope of this.registrationScopes) {
      scope.current = false;
      scope.superseded = true;
    }
    this.registrationScopes.clear();
    for (const { entry } of this.completionAuthorities.values()) {
      this.releaseCompletionAuthority(entry);
    }
    for (const scope of this.retirementScopes) {
      completeRetirementPublication(scope);
      scope.observation = { state: "superseded" };
    }
    this.retirementScopes.clear();
    super.clear();
    this.readLookup = new SubagentSessionReadLookup();
    collectorRunIdByChildSessionKey.clear();
    runsByChildSessionKey.clear();
    runsByRequesterSessionKey.clear();
    runsByCollectorGroupKey.clear();
    publishSubagentRunChanges();
  }
}

export const subagentRuns = new SubagentRunMap();

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

export function getSubagentSessionReadLookup(runs: Map<string, SubagentRunRecord>) {
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

/** Iterate live generations for one child session without scanning the registry. */
export function* getSubagentRunsForChildSession(
  childSessionKey: string,
  childAgentId?: string,
): Iterable<SubagentRunRecord> {
  for (const entry of runsByChildSessionKey.get(childSessionKey)?.values() ?? []) {
    if (matchesSubagentChildSessionOwner(entry, childSessionKey, childAgentId)) {
      yield entry;
    }
  }
}

/** Current requester-owned generations, without restoring or scanning retained rows. */
export function getSubagentRunsForRequesterSession(
  requesterSessionKey: string,
): Iterable<SubagentRunRecord> {
  return runsByRequesterSessionKey.get(requesterSessionKey)?.values() ?? [];
}

/** Iterate live collector members for one requester/group archive decision. */
export function getSubagentRunsForCollectorGroup(
  requesterSessionKey: string,
  groupId: string,
  requesterAgentId?: string,
): Iterable<[string, SubagentRunRecord]> {
  const key = JSON.stringify([requesterSessionKey, groupId]);
  // Restore can backfill agent ownership after index insertion; read the live owner.
  return [...(runsByCollectorGroupKey.get(key)?.entries() ?? [])].filter(
    ([, entry]) => entry.requesterAgentId === requesterAgentId,
  );
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
  if (childAgentId !== undefined && !parseAgentSessionKey(key)) {
    let collector: SubagentRunRecord | undefined;
    for (const entry of getSubagentRunsForChildSession(key, childAgentId)) {
      if (entry.collect === true) {
        collector = entry;
      }
    }
    return collector;
  }
  const runId = collectorRunIdByChildSessionKey.get(key);
  return runId ? subagentRuns.get(runId) : undefined;
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
