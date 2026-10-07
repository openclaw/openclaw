import { resolveControllerSessionKey } from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

type RunIdentity = Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">;
type LookupIdentity = RunIdentity &
  Pick<SubagentRunReadRecord, "runId" | "swarmRunId" | "schedulerSlotId" | "controllerSessionKey">;

function buildChildren(runGroups: readonly Iterable<RunIdentity>[]) {
  const children = new Map<string, Set<string>>();
  for (const runs of runGroups) {
    for (const run of runs) {
      const child = run.childSessionKey.trim();
      if (!child) {
        continue;
      }
      const siblings = children.get(run.requesterSessionKey) ?? new Set<string>();
      siblings.add(child);
      children.set(run.requesterSessionKey, siblings);
    }
  }
  return children;
}

function collectKeys(
  sessionKeys: readonly string[],
  ...childrenForRequester: Array<(requester: string) => Iterable<string>>
): Set<string> {
  const selected = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
  // Include superseded edges; the read index owns the global latest-child veto.
  for (const requester of selected) {
    for (const children of childrenForRequester) {
      for (const child of children(requester)) {
        selected.add(child);
      }
    }
  }
  return selected;
}

/** Select a complete requester closure; the read index still owns generation and liveness policy. */
export function collectSubagentSessionReadKeys(
  sessionKeys: readonly string[],
  ...runGroups: Iterable<RunIdentity>[]
): Set<string> {
  const children = buildChildren(runGroups);
  return collectKeys(sessionKeys, (requester) => children.get(requester) ?? []);
}

type LookupMembership = {
  cacheKey: string;
  entry: LookupIdentity;
  runId: string;
  swarmRunId?: string;
  schedulerSlotId?: string;
  requester: string;
  child: string;
  controller: string;
  order: number;
};
type SessionBuckets = {
  children: Map<string, Map<string, number>>;
  byChild: Map<string, Set<LookupMembership>>;
  byController: Map<string, Set<LookupMembership>>;
  byOwner: Map<string, Set<LookupMembership>>;
};

/** Derived membership only; the cache's snapshot Map remains the record owner. */
export class SubagentSessionReadLookup {
  #memberships = new Map<string, LookupMembership>();
  #byRunId = new Map<string, Set<LookupMembership>>();
  #sessions?: SessionBuckets;
  #nextOrder = 0;

  constructor(entries: Iterable<readonly [string, LookupIdentity]> = []) {
    for (const [cacheKey, entry] of entries) {
      this.set(cacheKey, entry);
    }
  }

  set(cacheKey: string, entry: LookupIdentity | undefined): void {
    const previous = this.#memberships.get(cacheKey);
    if (!entry) {
      if (previous) {
        this.#remove(previous);
        this.#memberships.delete(cacheKey);
      }
      return;
    }
    const child = entry.childSessionKey.trim();
    const requester = entry.requesterSessionKey;
    const controller = resolveControllerSessionKey(entry);
    if (
      previous &&
      previous.runId === entry.runId &&
      previous.swarmRunId === entry.swarmRunId &&
      previous.schedulerSlotId === entry.schedulerSlotId &&
      previous.child === child &&
      previous.requester === requester &&
      previous.controller === controller
    ) {
      previous.entry = entry;
      return;
    }
    if (previous) {
      this.#remove(previous);
    }
    const membership: LookupMembership = {
      cacheKey,
      entry,
      runId: entry.runId,
      swarmRunId: entry.swarmRunId,
      schedulerSlotId: entry.schedulerSlotId,
      child,
      requester,
      controller,
      order: previous?.order ?? this.#nextOrder++,
    };
    this.#memberships.set(cacheKey, membership);
    for (const id of [membership.runId, membership.swarmRunId, membership.schedulerSlotId]) {
      if (id) {
        this.#addToBucket(this.#byRunId, id, membership);
      }
    }
    this.#indexSession(membership);
  }

  /** Broad publications invalidate relationships without rebuilding the eager run-ID index. */
  invalidateSessions(): void {
    this.#sessions = undefined;
  }

  #sessionBuckets(): SessionBuckets {
    if (!this.#sessions) {
      this.#sessions = {
        children: new Map(),
        byChild: new Map(),
        byController: new Map(),
        byOwner: new Map(),
      };
      for (const membership of this.#memberships.values()) {
        membership.child = membership.entry.childSessionKey.trim();
        membership.requester = membership.entry.requesterSessionKey;
        membership.controller = resolveControllerSessionKey(membership.entry);
        this.#indexSession(membership);
      }
    }
    return this.#sessions;
  }

  #indexSession(membership: LookupMembership): void {
    const buckets = this.#sessions;
    if (!buckets) {
      return;
    }
    const { requester, controller } = membership;
    for (const owner of new Set([requester.trim(), controller.trim()])) {
      this.#addToBucket(buckets.byOwner, owner, membership);
    }
    if (membership.child) {
      const children = buckets.children.get(membership.requester) ?? new Map<string, number>();
      children.set(membership.child, (children.get(membership.child) ?? 0) + 1);
      buckets.children.set(membership.requester, children);
      this.#addToBucket(buckets.byChild, membership.child, membership);
    }
    if (membership.controller) {
      this.#addToBucket(buckets.byController, membership.controller, membership);
    }
  }

  selectRunIds(ids: ReadonlySet<string>, additionalCacheKeys: readonly string[] = []): string[] {
    return this.#select(this.#byRunId, ids, additionalCacheKeys);
  }

  selectSessions(sessionKeys: readonly string[], inMemoryRuns: Iterable<RunIdentity>) {
    const buckets = this.#sessionBuckets();
    const liveChildren = buildChildren([inMemoryRuns]);
    const selected = collectKeys(
      sessionKeys,
      (requester) => buckets.children.get(requester)?.keys() ?? [],
      (requester) => liveChildren.get(requester) ?? [],
    );
    return { sessionKeys: selected, cacheKeys: this.#select(buckets.byChild, selected) };
  }

  selectChildren(childKeys: ReadonlySet<string>): string[] {
    return this.#select(this.#sessionBuckets().byChild, childKeys);
  }

  selectControllers(controllerKeys: ReadonlySet<string>): string[] {
    return this.#select(this.#sessionBuckets().byController, controllerKeys);
  }

  /** Include every generation of selected children, even after an ownership move. */
  selectReadScope(
    sessionKeys: readonly string[],
    other: SubagentSessionReadLookup,
    descendants: boolean,
    additionalCacheKeys: readonly string[] = [],
  ): string[] {
    const owners = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const children = new Set(descendants ? owners : []);
    const buckets = this.#sessionBuckets();
    const otherBuckets = other.#sessionBuckets();
    for (const owner of owners) {
      for (const lookup of [buckets, otherBuckets]) {
        for (const row of lookup.byOwner.get(owner) ?? []) {
          if (row.child) {
            children.add(row.child);
            if (descendants) {
              owners.add(row.child);
            }
          }
        }
      }
    }
    const keys = new Set([
      ...this.#select(buckets.byOwner, owners),
      ...this.selectChildren(children),
      ...additionalCacheKeys.filter((key) => this.#memberships.has(key)),
    ]);
    return [...keys].toSorted(
      (a, b) => this.#memberships.get(a)!.order - this.#memberships.get(b)!.order,
    );
  }

  #select(
    buckets: Map<string, Set<LookupMembership>>,
    keys: ReadonlySet<string>,
    additionalCacheKeys: readonly string[] = [],
  ): string[] {
    const selected = new Set<LookupMembership>();
    for (const key of keys) {
      for (const membership of buckets.get(key) ?? []) {
        selected.add(membership);
      }
    }
    for (const key of additionalCacheKeys) {
      const membership = this.#memberships.get(key);
      if (membership) {
        selected.add(membership);
      }
    }
    if (selected.size === this.#memberships.size) {
      return [...this.#memberships.keys()];
    }
    // Bucket traversal can change after a move; snapshot iteration order cannot.
    return [...selected]
      .toSorted((left, right) => left.order - right.order)
      .map((row) => row.cacheKey);
  }

  #addToBucket(
    buckets: Map<string, Set<LookupMembership>>,
    key: string,
    membership: LookupMembership,
  ) {
    const bucket = buckets.get(key) ?? new Set<LookupMembership>();
    bucket.add(membership);
    buckets.set(key, bucket);
  }

  #removeFromBucket(
    buckets: Map<string, Set<LookupMembership>>,
    key: string,
    membership: LookupMembership,
  ) {
    const bucket = buckets.get(key);
    bucket?.delete(membership);
    if (bucket?.size === 0) {
      buckets.delete(key);
    }
  }

  #remove(membership: LookupMembership) {
    for (const id of [membership.runId, membership.swarmRunId, membership.schedulerSlotId]) {
      if (id) {
        this.#removeFromBucket(this.#byRunId, id, membership);
      }
    }
    const buckets = this.#sessions;
    if (!buckets) {
      return;
    }
    const children = buckets.children.get(membership.requester);
    const remaining = (children?.get(membership.child) ?? 0) - 1;
    if (remaining > 0) {
      children?.set(membership.child, remaining);
    } else {
      children?.delete(membership.child);
      if (children?.size === 0) {
        buckets.children.delete(membership.requester);
      }
    }
    this.#removeFromBucket(buckets.byChild, membership.child, membership);
    this.#removeFromBucket(buckets.byController, membership.controller, membership);
    for (const owner of new Set([membership.requester.trim(), membership.controller.trim()])) {
      this.#removeFromBucket(buckets.byOwner, owner, membership);
    }
  }
}
