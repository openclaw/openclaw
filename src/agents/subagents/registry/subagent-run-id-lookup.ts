import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

type Identity = Pick<SubagentRunReadRecord, "runId" | "swarmRunId">;
type Membership = Identity & { cacheKey: string; order: number };

/** Derived exact/collector membership; the publishing Map remains the record owner. */
export class SubagentRunIdLookup {
  #memberships = new Map<string, Membership>();
  #byId = new Map<string, Set<Membership>>();
  #nextOrder = 0;

  constructor(entries: Iterable<readonly [string, Identity]> = []) {
    for (const [key, entry] of entries) {
      this.set(key, entry);
    }
  }

  set(cacheKey: string, entry: Identity | undefined): void {
    const previous = this.#memberships.get(cacheKey);
    if (previous) {
      if (entry && previous.runId === entry.runId && previous.swarmRunId === entry.swarmRunId) {
        return;
      }
      for (const id of [previous.runId, previous.swarmRunId]) {
        if (!id) {
          continue;
        }
        const bucket = this.#byId.get(id);
        bucket?.delete(previous);
        if (bucket?.size === 0) {
          this.#byId.delete(id);
        }
      }
      this.#memberships.delete(cacheKey);
    }
    if (!entry) {
      return;
    }
    const membership = {
      cacheKey,
      runId: entry.runId,
      swarmRunId: entry.swarmRunId,
      order: previous?.order ?? this.#nextOrder++,
    };
    this.#memberships.set(cacheKey, membership);
    for (const id of [membership.runId, membership.swarmRunId]) {
      if (id) {
        const bucket = this.#byId.get(id) ?? new Set<Membership>();
        bucket.add(membership);
        this.#byId.set(id, bucket);
      }
    }
  }

  /** Keep snapshot order, including persisted rows that entered the selection through live facts. */
  select(ids: ReadonlySet<string>, additionalCacheKeys: readonly string[] = []): string[] {
    const selected = new Set<Membership>();
    for (const id of ids) {
      for (const membership of this.#byId.get(id) ?? []) {
        selected.add(membership);
      }
    }
    for (const key of additionalCacheKeys) {
      const membership = this.#memberships.get(key);
      if (membership) {
        selected.add(membership);
      }
    }
    return [...selected]
      .toSorted((left, right) => left.order - right.order)
      .map((membership) => membership.cacheKey);
  }
}
