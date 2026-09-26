/**
 * Process-local live subagent run map.
 *
 * Shared by registry read/write helpers for active in-memory run state.
 */
import { isDeepStrictEqual } from "node:util";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { transferFollowupCohort } from "../../../tasks/task-followup-cohort.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentRunIdLookup } from "./subagent-run-id-lookup.js";

// Preflight consults the collector lookup on every Gateway agent request, so it
// must stay O(1) regardless of retained collector records. The map subclass
// maintains the index through every existing mutation path (registry, run
// manager, tests); collector identity and childSessionKey are fixed at
// registration, so in-place lifecycle field edits never require re-indexing.
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

const retirementPublications = new WeakMap<
  SubagentRunRecord,
  Set<SubagentRetirementScope["publication"]>
>();

export function waitForSubagentRetirementPublication(
  entry: SubagentRunRecord,
): Promise<void> | undefined {
  const pending = retirementPublications.get(entry);
  if (!pending?.size) {
    return undefined;
  }
  return Promise.all([...pending].map((publication) => publication.promise)).then(() => undefined);
}

export function hasPendingSubagentRetirementPublication(entry: SubagentRunRecord): boolean {
  return Boolean(retirementPublications.get(entry)?.size);
}

function completeRetirementPublication(scope: SubagentRetirementScope): void {
  const publication = scope.publication;
  if (publication.settled) {
    return;
  }
  publication.settled = true;
  const pending = retirementPublications.get(publication.entry);
  pending?.delete(publication);
  if (pending?.size === 0) {
    retirementPublications.delete(publication.entry);
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
  runIdLookup = new SubagentRunIdLookup();
  private readonly retirementScopes = new Set<SubagentRetirementScope>();
  private readonly registrationScopes = new Set<{ childSessionKey: string; current: boolean }>();
  private readonly completionAuthorities = new Map<SubagentRunRecord, CompletionCustody>();
  // A tombstone rejects stale callbacks without retaining closed Gateway/source contexts.
  private readonly operatorCompletionEntries = new WeakSet<SubagentRunRecord>();

  bindCompletionAuthority(entry: SubagentRunRecord, authority: CompletionAuthority): void {
    this.releaseCompletionAuthority(entry);
    const custody: CompletionCustody = {
      authority,
      entry,
      stop: () => authority.signal.removeEventListener("abort", revoked),
    };
    const revoked = () => this.releaseCompletionAuthority(custody.entry);
    this.completionAuthorities.set(entry, custody);
    this.operatorCompletionEntries.add(entry);
    authority.signal.addEventListener("abort", revoked, { once: true });
    if (authority.signal.aborted) {
      revoked();
    }
  }

  releaseCompletionAuthority(entry: SubagentRunRecord): void {
    const custody = this.completionAuthorities.get(entry);
    this.completionAuthorities.delete(entry);
    custody?.stop();
    custody?.authority.release();
  }

  runWithCompletionAuthority<T>(entry: SubagentRunRecord, run: () => T): T {
    const custody = this.completionAuthorities.get(entry);
    if (this.operatorCompletionEntries.has(entry) && this.get(entry.runId) !== entry) {
      throw new Error("Subagent completion authority is no longer active");
    }
    // Cancellation notices belong to the admitted cancellation caller, not its revoked target.
    // Keep that caller's existing dispatch restrictions; never turn a successful result into a notice.
    if (
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.execution.outcome?.status === "error"
    ) {
      return run();
    }
    if (this.operatorCompletionEntries.has(entry) && !custody) {
      throw new Error("Subagent completion authority is no longer active");
    }
    return custody ? custody.authority.run(run) : run();
  }

  runWithCompletionBatchAuthority<T>(batch: readonly SubagentRunRecord[], run: () => T): T {
    for (const entry of batch) {
      if (this.operatorCompletionEntries.has(entry) && this.get(entry.runId) !== entry) {
        throw new Error("Subagent completion authority is no longer active");
      }
    }
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
    const first = this.completionAuthorities.get(resultEntry)?.authority.operatorAuthority;
    // Mixed waves must still prove the cancelled member's original source is live and identical.
    // A revoked or unrelated cancellation cannot borrow a successful sibling's authority.
    for (const entry of batch) {
      const source = this.completionAuthorities.get(entry)?.authority.operatorAuthority;
      if (this.operatorCompletionEntries.has(entry) && !source) {
        throw new Error("Subagent completion authority is no longer active");
      }
      source?.assertCurrent();
      if (source?.source !== first?.source || !isDeepStrictEqual(source?.scopes, first?.scopes)) {
        throw new Error("Subagent completion batch has incompatible operator authority");
      }
    }
    return this.runWithCompletionAuthority(resultEntry, run);
  }

  /** Same-task replacement stages custody before publication and can restore it on rollback. */
  transferCompletionAuthority(previous: SubagentRunRecord, next: SubagentRunRecord): () => void {
    const restoreFollowup = transferFollowupCohort(previous, next);
    if (this.operatorCompletionEntries.has(previous)) {
      this.operatorCompletionEntries.add(next);
    }
    const custody = this.completionAuthorities.get(previous);
    if (!custody) {
      return restoreFollowup;
    }
    this.completionAuthorities.delete(previous);
    custody.entry = next;
    this.completionAuthorities.set(next, custody);
    this.operatorCompletionEntries.add(next);
    return () => {
      restoreFollowup();
      if (this.completionAuthorities.get(next) === custody) {
        this.completionAuthorities.delete(next);
        custody.entry = previous;
        this.completionAuthorities.set(previous, custody);
      }
    };
  }

  /** Only acknowledged registry state retires custody; tentative map writes can roll back. */
  settleCompletionAuthorities(
    committed: ReadonlyMap<string, SubagentRunRecord>,
    changedRunIds?: readonly string[],
  ): void {
    const changed = changedRunIds && new Set(changedRunIds);
    for (const entry of this.completionAuthorities.keys()) {
      if (changed && !changed.has(entry.runId)) {
        continue;
      }
      const record = committed.get(entry.runId);
      if (
        !record ||
        this.get(entry.runId) !== entry ||
        record.generation !== entry.generation ||
        record.execution.suppressSessionEffects === true ||
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
    let resolvePublication!: () => void;
    const publication = {
      entry,
      promise: new Promise<void>((resolve) => {
        resolvePublication = resolve;
      }),
      resolve: () => resolvePublication(),
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
    const pending = retirementPublications.get(entry);
    if (pending) {
      pending.add(publication);
    } else {
      retirementPublications.set(entry, new Set([publication]));
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
  captureRegistrationOwnership(childSessionKey: string) {
    const scope = { childSessionKey, current: true };
    this.registrationScopes.add(scope);
    return {
      assertCurrent: () => {
        if (!scope.current) {
          throw new Error("Subagent registration owner changed during preparation");
        }
      },
      release: () => {
        scope.current = false;
        this.registrationScopes.delete(scope);
      },
    };
  }

  /** Publish only accepted ownership, after synchronous registration/replacement rollback decisions. */
  commitOwnership(entry: SubagentRunRecord): void {
    if (this.get(entry.runId) !== entry) {
      return;
    }
    for (const scope of this.registrationScopes) {
      if (scope.childSessionKey === entry.childSessionKey) {
        scope.current = false;
      }
    }
    for (const scope of this.retirementScopes) {
      const previous = scope.observation.entry;
      if (
        previous &&
        previous !== entry &&
        previous.childSessionKey === entry.childSessionKey &&
        scope.isSuccessor(entry)
      ) {
        // New work supersedes the selected execution, even if the replacement
        // is retired before the pending Stop resumes.
        scope.observation = { state: "superseded" };
      }
    }
    publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  }

  /** Normal cleanup calls this only after its deletion commits; raw map deletion is not evidence. */
  confirmRetirement(entry: SubagentRunRecord): void {
    for (const scope of this.retirementScopes) {
      const observed = scope.observation;
      if (
        observed.entry === entry &&
        observed.state === "selected" &&
        this.get(entry.runId) !== entry
      ) {
        observed.state = "retired";
      }
    }
    publishSubagentRunChanges([entry.childSessionKey], [entry.runId]);
  }

  override set(runId: string, entry: SubagentRunRecord): this {
    const prev = this.get(runId);
    if (prev) {
      removeIndexedSubagentRun(runsByChildSessionKey, prev.childSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByRequesterSessionKey, prev.requesterSessionKey, runId, prev);
      removeIndexedSubagentRun(runsByCollectorGroupKey, collectorGroupKey(prev), runId, prev);
      if (prev.collect === true && prev.childSessionKey) {
        collectorRunIdByChildSessionKey.delete(prev.childSessionKey);
      }
    }
    super.set(runId, entry);
    this.runIdLookup.set(runId, entry);
    indexSubagentRun(runsByChildSessionKey, entry.childSessionKey, runId, entry);
    indexSubagentRun(runsByRequesterSessionKey, entry.requesterSessionKey, runId, entry);
    indexSubagentRun(runsByCollectorGroupKey, collectorGroupKey(entry), runId, entry);
    if (entry.collect === true && entry.childSessionKey) {
      collectorRunIdByChildSessionKey.set(entry.childSessionKey, runId);
    }
    return this;
  }

  override delete(runId: string): boolean {
    this.runIdLookup.set(runId, undefined);
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
    }
    this.registrationScopes.clear();
    for (const entry of this.completionAuthorities.keys()) {
      this.releaseCompletionAuthority(entry);
    }
    for (const scope of this.retirementScopes) {
      completeRetirementPublication(scope);
      scope.observation = { state: "superseded" };
    }
    this.retirementScopes.clear();
    super.clear();
    this.runIdLookup = new SubagentRunIdLookup();
    collectorRunIdByChildSessionKey.clear();
    runsByChildSessionKey.clear();
    runsByRequesterSessionKey.clear();
    runsByCollectorGroupKey.clear();
    publishSubagentRunChanges();
  }
}

export const subagentRuns = new SubagentRunMap();

/** The live owner maintains identity changes; unowned Maps have no publication lifecycle. */
export function getSubagentRunIdLookup(runs: Map<string, SubagentRunRecord>): SubagentRunIdLookup {
  return runs instanceof SubagentRunMap ? runs.runIdLookup : new SubagentRunIdLookup(runs);
}

/** Iterate live generations for one child session without scanning the registry. */
export function getSubagentRunsForChildSession(
  childSessionKey: string,
): Iterable<SubagentRunRecord> {
  return runsByChildSessionKey.get(childSessionKey)?.values() ?? [];
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
export function findSwarmCollectorSession(childSessionKey?: string): SubagentRunRecord | undefined {
  const key = childSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const runId = collectorRunIdByChildSessionKey.get(key);
  return runId ? subagentRuns.get(runId) : undefined;
}

/** Resolve the host-registered collector that authorizes a Gateway request. */
export function findAuthorizedSwarmCollectorRequest(params: {
  childSessionKey?: string;
  idempotencyKey?: string;
  outputSchema?: Record<string, unknown>;
}): SubagentRunRecord | undefined {
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return undefined;
  }
  const entry = findSwarmCollectorSession(params.childSessionKey);
  if (!entry) {
    return undefined;
  }
  return entry.swarmLaunchIdempotencyKey === idempotencyKey &&
    isDeepStrictEqual(entry.outputSchema, params.outputSchema)
    ? entry
    : undefined;
}
