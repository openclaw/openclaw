/**
 * Shared subagent registry query helpers.
 *
 * Combines snapshot traversal with current execution and reservation ownership.
 */
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import {
  buildSubagentRunReadTopology,
  resolveControllerSessionKey,
} from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  latestSubagentRun,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";
import {
  hasSubagentRunEnded,
  isRetainedUnendedSubagentRun,
  isSubagentRunQueued,
} from "./subagent-run-liveness.js";

function resolveConcurrencyOwnerSessionKey(entry: SubagentRunRecord): string {
  return entry.collect
    ? entry.swarmRequesterSessionKey?.trim() || resolveControllerSessionKey(entry)
    : resolveControllerSessionKey(entry);
}

function isDeliveryTerminalForRequesterSettle(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return (
    isDeliverySuspended(entry) ||
    entry.delivery?.disposition === "delivered" ||
    entry.delivery?.disposition === "intentional_non_delivery" ||
    entry.delivery?.disposition === "permanent_failure"
  );
}

/** Lists requester-owned runs, optionally scoped to the lifetime of a requester run. */
export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
    requesterAgentId?: string;
    requesterStorePath?: string | null;
  },
): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }

  const requesterRunId = options?.requesterRunId?.trim();
  const requesterRun = requesterRunId ? runs.get(requesterRunId) : undefined;
  const requesterRunMatchesScope =
    requesterRun && requesterRun.childSessionKey === key ? requesterRun : undefined;
  // When a requester run is provided, only include children created while that run was active.
  const lowerBound =
    requesterRunMatchesScope?.execution.startedAt ?? requesterRunMatchesScope?.createdAt;
  const upperBound = requesterRunMatchesScope?.execution.endedAt;

  const results: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (
      entry.requesterSessionKey === key &&
      (!options?.requesterAgentId || entry.requesterAgentId === options.requesterAgentId) &&
      (options?.requesterStorePath === undefined ||
        (entry.requesterStorePath ?? null) === options.requesterStorePath) &&
      (typeof lowerBound !== "number" || entry.createdAt >= lowerBound) &&
      (typeof upperBound !== "number" || entry.createdAt <= upperBound)
    ) {
      results.push(entry);
    }
  }
  return results;
}

export function selectConnectedSettledSubagentWave(
  candidates: readonly SubagentRunRecord[],
  settledEntry: SubagentRunRecord,
): SubagentRunRecord[] {
  const targetIndex = candidates.findIndex((entry) => entry.runId === settledEntry.runId);
  const target = candidates[targetIndex];
  if (!target) {
    return [];
  }

  const sorted = candidates
    .map((entry, originalIndex) => ({
      entry,
      originalIndex,
      endedAt:
        typeof entry.execution.endedAt === "number"
          ? entry.execution.endedAt
          : Number.MAX_SAFE_INTEGER,
    }))
    .toSorted(
      (a, b) =>
        a.entry.createdAt - b.entry.createdAt ||
        a.endedAt - b.endedAt ||
        a.originalIndex - b.originalIndex,
    );
  const first = sorted[0];
  if (!first) {
    return [];
  }

  let componentStart = 0;
  let componentEnd = first.endedAt;
  let containsTarget = first.originalIndex === targetIndex;
  for (let index = 1; index <= sorted.length; index += 1) {
    const next = sorted[index];
    // Interval-graph components are contiguous after sorting by spawn time.
    // Spawn time, rather than execution admission, keeps capacity-queued siblings together.
    if (!next || next.entry.createdAt > componentEnd) {
      if (containsTarget) {
        const component = sorted
          .slice(componentStart, index)
          .filter((item) => item.originalIndex !== targetIndex)
          .toSorted((a, b) => a.originalIndex - b.originalIndex);
        return [target, ...component.map((item) => item.entry)];
      }
      if (!next) {
        break;
      }
      componentStart = index;
      componentEnd = next.endedAt;
      containsTarget = next.originalIndex === targetIndex;
      continue;
    }
    componentEnd = Math.max(componentEnd, next.endedAt);
    containsTarget ||= next.originalIndex === targetIndex;
  }
  return [];
}

/** Lists runs controlled by the normalized controller session key. */
export function listRunsForControllerFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  controllerSessionKey: string,
  controllerAgentId?: string,
): T[] {
  const key = controllerSessionKey.trim();
  const results: T[] = [];
  if (!key) {
    return results;
  }
  for (const entry of runs.values()) {
    if (
      resolveControllerSessionKey(entry) === key &&
      (!controllerAgentId || entry.requesterAgentId === controllerAgentId)
    ) {
      results.push(entry);
    }
  }
  return results;
}

/** Cached read index for display, controller grouping, and descendant queries. */
export type SubagentRunReadIndex<T extends SubagentRunReadRecord = SubagentRunRecord> = {
  inputs: { runs: Map<string, T>; inMemoryRuns: Iterable<T> };
  /** Reuse prepared topology while leaving the captured view unchanged. */
  atTime(now: number): SubagentRunReadIndex<T>;
  /** Mutate this owner's topology; callers retire earlier views before applying changes. */
  patch(
    changes: ReadonlyMap<string, T | undefined>,
    inMemoryChanges: ReadonlyMap<string, T | undefined>,
    now?: number,
  ): SubagentRunReadIndex<T>;
  getDisplaySubagentRun(childSessionKey: string): T | null;
  latestRunsByChildSessionKey: ReadonlyMap<string, T>;
  runsByChildSessionKey: ReadonlyMap<string, readonly T[]>;
  countActiveDescendantRuns(rootSessionKey: string): number;
  countPendingDescendantRuns(rootSessionKey: string): number;
  hasDescendantRunAwaitingSettle(
    rootSessionKey: string,
    excludeRunId?: string,
    settledBefore?: number,
  ): boolean;
  listDescendantRunsForRequester(rootSessionKey: string): T[];
  runsByControllerSessionKey: ReadonlyMap<string, readonly T[]>;
  swarmRunsByRequesterSessionKey: ReadonlyMap<string, readonly T[]>;
};

export type LatestSubagentRunReadIndex<T extends SubagentRunReadRecord = SubagentRunRecord> = {
  getLatestSubagentRun(childSessionKey: string): T | null;
};

/** Builds a reusable latest-generation lookup from one registry snapshot. */
export function buildLatestSubagentRunReadIndexFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
): LatestSubagentRunReadIndex<T> {
  const latestRunByChildSessionKey = new Map<string, T>();
  for (const entry of runs.values()) {
    const childSessionKey = entry.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    recordLatestSubagentRun(latestRunByChildSessionKey, childSessionKey, entry);
  }
  return {
    getLatestSubagentRun: (childSessionKey) =>
      latestRunByChildSessionKey.get(childSessionKey.trim()) ?? null,
  };
}

type SubagentRunReadIndexParams<T extends SubagentRunReadRecord> = {
  runs: Map<string, T>;
  inMemoryRuns?: Iterable<T>;
  now?: number;
};

/** Builds a read index from snapshot and optional in-memory runs. */
export function buildSubagentRunReadIndexFromRuns<T extends SubagentRunReadRecord>(
  params: SubagentRunReadIndexParams<T>,
): SubagentRunReadIndex<T> {
  const { runs } = params;
  const now = params.now ?? Date.now();
  const topology = buildSubagentRunReadTopology(params);
  const {
    inputs,
    inMemoryDisplayByChildSessionKey,
    runsByChildSessionKey,
    latestRunsByChildSessionKey,
    runsByControllerSessionKey,
    swarmRunsByRequesterSessionKey,
    latestRunByRequesterAndChildSessionKey,
  } = topology;

  const isRetainedReadRun = (entry: T, clock = now): boolean => {
    if (isRetainedUnendedSubagentRun(entry, clock)) {
      return true;
    }
    if (hasSubagentRunEnded(entry) || entry.execution.status !== "queued") {
      return false;
    }
    // Compact projections cannot own reservations; only the matching raw owner can.
    const current = inMemoryDisplayByChildSessionKey.get(entry.childSessionKey.trim());
    return (
      current !== undefined &&
      current.requesterSessionKey === entry.requesterSessionKey &&
      compareSubagentRunGeneration(current, entry) === 0 &&
      isSubagentRunQueued(current)
    );
  };

  const atTime = (clock: number, captured?: ReadonlySet<T>): SubagentRunReadIndex<T> => {
    const activeDescendantCountBySessionKey = new Map<string, number>();
    const pendingDescendantCountBySessionKey = new Map<string, number>();
    const displayByChildSessionKey = new Map<string, T | null>();
    const getDisplaySubagentRun = (childSessionKey: string): T | null => {
      const key = childSessionKey.trim();
      if (!key) {
        return null;
      }
      if (displayByChildSessionKey.has(key)) {
        return displayByChildSessionKey.get(key) ?? null;
      }
      const selected =
        inMemoryDisplayByChildSessionKey.get(key) ??
        latestSubagentRun(
          runsByChildSessionKey.get(key) ?? [],
          (entry) => captured?.has(entry) ?? isRetainedReadRun(entry, clock),
        ) ??
        latestRunsByChildSessionKey.get(key) ??
        null;
      displayByChildSessionKey.set(key, selected);
      return selected;
    };

    const forEachDescendantRun = (
      rootSessionKey: string,
      visitor: (entry: T) => void | boolean,
    ): void => {
      const root = rootSessionKey.trim();
      if (!root) {
        return;
      }
      const pending = [root];
      const visited = new Set<string>([root]);
      for (const requester of pending) {
        for (const [childSessionKey, entry] of latestRunByRequesterAndChildSessionKey.get(
          requester,
        ) ?? []) {
          // Only traverse the latest run per child; older retries should not keep descendants alive.
          if (latestRunsByChildSessionKey.get(childSessionKey) !== entry) {
            continue;
          }
          if (visitor(entry) === true) {
            return;
          }
          if (visited.has(childSessionKey)) {
            continue;
          }
          visited.add(childSessionKey);
          pending.push(childSessionKey);
        }
      }
    };

    const countActiveDescendantRuns = (rootSessionKey: string): number => {
      const root = rootSessionKey.trim();
      if (!root) {
        return 0;
      }
      if (activeDescendantCountBySessionKey.has(root)) {
        return activeDescendantCountBySessionKey.get(root) ?? 0;
      }
      let count = 0;
      forEachDescendantRun(root, (entry) => {
        if (isRetainedReadRun(entry, clock)) {
          count += 1;
        }
      });
      activeDescendantCountBySessionKey.set(root, count);
      return count;
    };

    const countPendingDescendantRunsInternal = (
      rootSessionKey: string,
      options?: {
        excludeRunId?: string;
        settledBefore?: number;
        treatSuspendedDeliveryAsSettled?: boolean;
        stopAtFirst?: boolean;
      },
    ): number => {
      const excludedRunId = options?.excludeRunId?.trim();
      let count = 0;
      forEachDescendantRun(rootSessionKey, (entry) => {
        if (entry.runId === excludedRunId) {
          return false;
        }
        // Earlier delivery bookkeeping cannot block a later completion wave.
        // Traversal still visits this row's descendants, including live work.
        if (
          options?.settledBefore !== undefined &&
          hasSubagentRunEnded(entry) &&
          entry.execution.endedAt < options.settledBefore
        ) {
          return false;
        }
        const runPending = hasSubagentRunEnded(entry)
          ? typeof entry.cleanupCompletedAt !== "number" &&
            !(
              options?.treatSuspendedDeliveryAsSettled === true &&
              isDeliveryTerminalForRequesterSettle(entry)
            )
          : isRetainedReadRun(entry, clock);
        if (runPending) {
          count += 1;
          if (options?.stopAtFirst === true) {
            return true;
          }
        }
        return false;
      });
      return count;
    };

    const countPendingDescendantRuns = (rootSessionKey: string): number => {
      const root = rootSessionKey.trim();
      if (!root) {
        return 0;
      }
      if (pendingDescendantCountBySessionKey.has(root)) {
        return pendingDescendantCountBySessionKey.get(root) ?? 0;
      }
      const count = countPendingDescendantRunsInternal(root);
      pendingDescendantCountBySessionKey.set(root, count);
      return count;
    };

    const hasDescendantRunAwaitingSettle = (
      rootSessionKey: string,
      excludeRunId?: string,
      settledBefore?: number,
    ): boolean =>
      countPendingDescendantRunsInternal(rootSessionKey, {
        excludeRunId,
        settledBefore,
        treatSuspendedDeliveryAsSettled: true,
        stopAtFirst: true,
      }) > 0;

    const listDescendantRunsForRequester = (rootSessionKey: string): T[] => {
      const descendants: T[] = [];
      forEachDescendantRun(rootSessionKey, (entry) => {
        descendants.push(entry);
      });
      return descendants;
    };

    return {
      inputs,
      atTime,
      patch,
      getDisplaySubagentRun,
      latestRunsByChildSessionKey,
      runsByChildSessionKey,
      countActiveDescendantRuns,
      countPendingDescendantRuns,
      hasDescendantRunAwaitingSettle,
      listDescendantRunsForRequester,
      runsByControllerSessionKey,
      swarmRunsByRequesterSessionKey,
    };
  };
  function patch(
    changes: ReadonlyMap<string, T | undefined>,
    inMemoryChanges: ReadonlyMap<string, T | undefined>,
    clock = Date.now(),
  ): SubagentRunReadIndex<T> {
    topology.patch(changes, inMemoryChanges);
    return atTime(clock);
  }
  // Capture display classification; descendant queries inspect live owners at use time.
  const retainedReadRuns = new Set([...runs.values()].filter((entry) => isRetainedReadRun(entry)));
  return atTime(now, retainedReadRuns);
}

/**
 * Returns the latest-generation run for a child session.
 *
 * `matches` narrows the candidates before the generation comparison, so callers
 * that own a specific row class (a paused continuation target, say) select the
 * newest row of that class rather than the newest row overall. Without it a
 * sibling registered at a higher generation hides the row the caller owns.
 */
export function getLatestSubagentRunByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord> | Iterable<SubagentRunRecord>,
  childSessionKey: string,
  matches?: (entry: SubagentRunRecord) => boolean,
): SubagentRunRecord | undefined {
  const key = childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  return latestSubagentRun(
    runs instanceof Map ? runs.values() : runs,
    (entry) => entry.childSessionKey === key && (!matches || matches(entry)),
  );
}

/** Returns the preferred run for a child session, active first then latest ended. */
export function getSubagentRunByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestActive: SubagentRunRecord | null = null;
  let latestEnded: SubagentRunRecord | null = null;
  for (const entry of runs.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (isRetainedUnendedSubagentRun(entry)) {
      if (!latestActive || compareSubagentRunGeneration(entry, latestActive) > 0) {
        latestActive = entry;
      }
      continue;
    }
    if (!latestEnded || compareSubagentRunGeneration(entry, latestEnded) > 0) {
      latestEnded = entry;
    }
  }

  return latestActive ?? latestEnded;
}

/** Resolves the requester and delivery origin for the latest child-session run. */
export function resolveRequesterForChildSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey);
  if (!latest) {
    return null;
  }
  return {
    requesterSessionKey: latest.requesterSessionKey,
    requesterAgentId: latest.requesterAgentId,
    requesterOrigin: latest.requesterOrigin,
  };
}

/** Returns whether post-completion announce should be skipped for a cleaned-up run. */
export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): boolean {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey);
  return Boolean(
    latest &&
    latest.spawnMode !== "session" &&
    typeof latest.execution.endedAt === "number" &&
    typeof latest.cleanupCompletedAt === "number" &&
    latest.cleanupCompletedAt >= latest.execution.endedAt,
  );
}

export function listSwarmRunsForGroupFromRuns(
  runs: Map<string, SubagentRunRecord>,
  groupId: string,
  requesterSessionKey?: string,
  requesterAgentId?: string,
): SubagentRunRecord[] {
  const key = groupId.trim();
  const requesterKey = requesterSessionKey?.trim();
  return [...runs.values()].filter(
    (entry) =>
      entry.collect === true &&
      entry.groupId === key &&
      (!requesterKey ||
        (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey) &&
      (!requesterAgentId || entry.requesterAgentId === requesterAgentId),
  );
}

/** Counts active direct child runs plus completed children that still have pending descendants. */
export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
  options?: { collect?: boolean; requesterAgentId?: string },
): number {
  const key = controllerSessionKey.trim();
  if (!key) {
    return 0;
  }

  const now = Date.now();
  let readIndex: SubagentRunReadIndex | undefined;

  const latestByChildSessionKey = new Map<string, SubagentRunRecord>();
  // Records already carry collect, and spawn admission is not request-hot, so a
  // filtered snapshot is simpler than maintaining a second registry index.
  for (const entry of runs.values()) {
    if (options?.collect !== undefined && (entry.collect === true) !== options.collect) {
      continue;
    }
    if (resolveConcurrencyOwnerSessionKey(entry) !== key) {
      continue;
    }
    if (options?.requesterAgentId && entry.requesterAgentId !== options.requesterAgentId) {
      continue;
    }
    recordLatestSubagentRun(latestByChildSessionKey, entry.childSessionKey, entry);
  }

  let count = 0;
  for (const entry of latestByChildSessionKey.values()) {
    if (isRetainedUnendedSubagentRun(entry)) {
      count += 1;
      continue;
    }
    readIndex ??= buildSubagentRunReadIndexFromRuns({ runs, now });
    if (readIndex.countPendingDescendantRuns(entry.childSessionKey) > 0) {
      count += 1;
    }
  }
  return count;
}

function scopeRootDescendantsToRequesterAgent(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  requesterAgentId?: string,
  requesterStorePath?: string | null,
  rootRunIds?: ReadonlySet<string>,
): Map<string, SubagentRunRecord> {
  return requesterAgentId || requesterStorePath !== undefined || rootRunIds
    ? new Map(
        [...runs].filter(
          ([, entry]) =>
            entry.requesterSessionKey !== rootSessionKey ||
            ((!rootRunIds || rootRunIds.has(entry.runId)) &&
              (!requesterAgentId || entry.requesterAgentId === requesterAgentId) &&
              (requesterStorePath === undefined ||
                (entry.requesterStorePath ?? null) === requesterStorePath)),
        ),
      )
    : runs;
}

/** Counts live descendants under a requester/session tree. */
export function countActiveDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  requesterAgentId?: string,
  requesterStorePath?: string | null,
  rootRunIds?: ReadonlySet<string>,
): number {
  return buildSubagentRunReadIndexFromRuns({
    runs: scopeRootDescendantsToRequesterAgent(
      runs,
      rootSessionKey,
      requesterAgentId,
      requesterStorePath,
      rootRunIds,
    ),
  }).countActiveDescendantRuns(rootSessionKey);
}

/** Counts descendants that are live or ended but not yet cleaned up. */
export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return buildSubagentRunReadIndexFromRuns({ runs }).countPendingDescendantRuns(rootSessionKey);
}

/**
 * True when any descendant below a root session has not reached a terminal
 * settle. Differs from the pending count in one way: a run whose final
 * delivery was suspended counts as settled — suspension is terminal for
 * automatic announce retries, so requester-drain decisions must not wait on it.
 */
export function hasDescendantRunAwaitingSettleFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId?: string,
  requesterAgentId?: string,
  requesterStorePath?: string | null,
  settledBefore?: number,
  rootRunIds?: ReadonlySet<string>,
): boolean {
  return buildSubagentRunReadIndexFromRuns({
    runs: scopeRootDescendantsToRequesterAgent(
      runs,
      rootSessionKey,
      requesterAgentId,
      requesterStorePath,
      rootRunIds,
    ),
  }).hasDescendantRunAwaitingSettle(rootSessionKey, excludeRunId, settledBefore);
}

/** Lists latest descendant runs under a requester/session tree. */
export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  return buildSubagentRunReadIndexFromRuns({ runs }).listDescendantRunsForRequester(rootSessionKey);
}
