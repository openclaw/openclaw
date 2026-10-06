import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import {
  buildSubagentRunReadTopology,
  resolveControllerSessionKey,
} from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isSameSubagentRun,
  latestSubagentRun,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isRetainedUnendedSubagentRun } from "./subagent-run-liveness.js";

function resolveConcurrencyOwnerSessionKey(entry: SubagentRunReadRecord): string {
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

export function matchesSubagentRequesterSession(
  entry: Pick<
    SubagentRunRecord,
    "completionRequesterSessionId" | "completionRequesterLifecycleRevision"
  >,
  requester: { sessionId: string; lifecycleRevision?: string },
): boolean {
  return (
    entry.completionRequesterSessionId === requester.sessionId &&
    entry.completionRequesterLifecycleRevision === requester.lifecycleRevision
  );
}

/** Lists requester-owned runs, optionally scoped to a requester run or session incarnation. */
export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
  options?: {
    requesterRunId?: string;
    requesterSessionId?: string;
    requesterLifecycleRevision?: string;
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
  // A newer owner outside this incarnation must still supersede its older row.
  const latestRuns =
    options?.requesterSessionId === undefined
      ? undefined
      : buildLatestSubagentRunReadIndexFromRuns(runs);

  return [...runs.values()].filter(
    (entry) =>
      entry.requesterSessionKey === key &&
      (options?.requesterSessionId === undefined ||
        matchesSubagentRequesterSession(entry, {
          sessionId: options.requesterSessionId,
          lifecycleRevision: options.requesterLifecycleRevision,
        })) &&
      (!latestRuns ||
        latestRuns.getLatestSubagentRun(entry.childSessionKey, entry.childAgentId) === entry) &&
      (!options?.requesterAgentId || entry.requesterAgentId === options.requesterAgentId) &&
      (options?.requesterStorePath === undefined ||
        (entry.requesterStorePath ?? null) === options.requesterStorePath) &&
      (typeof lowerBound !== "number" || entry.createdAt >= lowerBound) &&
      (typeof upperBound !== "number" || entry.createdAt <= upperBound),
  );
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

export function listRunsForControllerFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  controllerSessionKey: string,
  controllerAgentId?: string,
): T[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...runs.values()].filter(
    (entry) =>
      resolveControllerSessionKey(entry) === key &&
      (!controllerAgentId || entry.requesterAgentId === controllerAgentId),
  );
}

export type SubagentRunReadIndex<T extends SubagentRunReadRecord = SubagentRunRecord> = {
  inputs: { runs: Map<string, T>; inMemoryRuns: Iterable<T> };
  /** Identity of published topology facts, shared by clock-specific views. */
  revision: object;
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
  countPendingDescendantRuns(
    rootSessionKey: string,
    options?: { excludeSuspendedDelivery?: boolean },
  ): number;
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
  getLatestSubagentRun: (childSessionKey: string, childAgentId?: string) => T | null;
};

export function buildLatestSubagentRunReadIndexFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
): LatestSubagentRunReadIndex<T> {
  const latestRunByChildSessionKey = new Map<string, T>();
  const runsByChildSessionKey = new Map<string, T[]>();
  for (const entry of runs.values()) {
    const childSessionKey = entry.childSessionKey.trim();
    if (!childSessionKey) {
      continue;
    }
    recordLatestSubagentRun(latestRunByChildSessionKey, childSessionKey, entry);
    const bucket = runsByChildSessionKey.get(childSessionKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      runsByChildSessionKey.set(childSessionKey, [entry]);
    }
  }
  return {
    getLatestSubagentRun: (childSessionKey, childAgentId) => {
      const key = childSessionKey.trim();
      return childAgentId === undefined
        ? (latestRunByChildSessionKey.get(key) ?? null)
        : (latestSubagentRun(runsByChildSessionKey.get(key) ?? [], (entry) =>
            matchesSubagentChildSessionOwner(entry, key, childAgentId),
          ) ?? null);
    },
  };
}

type SubagentRunReadIndexParams<T extends SubagentRunReadRecord> = {
  runs: Map<string, T>;
  inMemoryRuns?: Iterable<T>;
  now?: number;
};

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
    getDescendantRuns,
  } = topology;

  const isRetainedReadRun = (entry: T, clock = now): boolean => {
    if (isRetainedUnendedSubagentRun(entry, clock)) {
      return true;
    }
    if (hasSubagentRunEnded(entry)) {
      return false;
    }
    // Compact facts resolve status through the captured resident owner, never acquire custody.
    const current = inMemoryDisplayByChildSessionKey.get(entry.childSessionKey.trim());
    return (
      current !== undefined &&
      isSameSubagentRun(current, entry) &&
      isRetainedUnendedSubagentRun(current, clock)
    );
  };

  const atTime = (clock: number, captured?: ReadonlySet<T>): SubagentRunReadIndex<T> => {
    const activeDescendantCountBySessionKey = new Map<string, number>();
    const pendingDescendantCountBySessionKey = new Map<string, number>();
    const admissionPendingDescendantCountBySessionKey = new Map<string, number>();
    const displayByChildSessionKey = new Map<string, T | null>();
    const getDisplaySubagentRun = (childSessionKey: string): T | null => {
      const key = childSessionKey.trim();
      if (!key || !runsByChildSessionKey.has(key)) {
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

    const countActiveDescendantRuns = (rootSessionKey: string): number => {
      const root = rootSessionKey.trim();
      const descendants = getDescendantRuns(root);
      if (!descendants.length) {
        return 0;
      }
      if (activeDescendantCountBySessionKey.has(root)) {
        return activeDescendantCountBySessionKey.get(root) ?? 0;
      }
      let count = 0;
      for (const entry of descendants) {
        if (isRetainedReadRun(entry, clock)) {
          count += 1;
        }
      }
      activeDescendantCountBySessionKey.set(root, count);
      return count;
    };

    const countPendingDescendantRunsInternal = (
      rootSessionKey: string,
      options?: {
        excludeRunId?: string;
        settledBefore?: number;
        excludeSuspendedDelivery?: boolean;
        treatSuspendedDeliveryAsSettled?: boolean;
        stopAtFirst?: boolean;
      },
    ): number => {
      const excludedRunId = options?.excludeRunId?.trim();
      let count = 0;
      for (const entry of getDescendantRuns(rootSessionKey)) {
        if (entry.runId === excludedRunId) {
          continue;
        }
        // Earlier delivery bookkeeping cannot block a later completion wave.
        // Traversal still visits this row's descendants, including live work.
        if (
          options?.settledBefore !== undefined &&
          hasSubagentRunEnded(entry) &&
          entry.execution.endedAt < options.settledBefore
        ) {
          continue;
        }
        const runPending = hasSubagentRunEnded(entry)
          ? typeof entry.cleanupCompletedAt !== "number" &&
            !(options?.excludeSuspendedDelivery === true && isDeliverySuspended(entry)) &&
            !(
              options?.treatSuspendedDeliveryAsSettled === true &&
              isDeliveryTerminalForRequesterSettle(entry)
            )
          : isRetainedReadRun(entry, clock);
        if (runPending) {
          count += 1;
          if (options?.stopAtFirst === true) {
            return count;
          }
        }
      }
      return count;
    };

    const countPendingDescendantRuns = (
      rootSessionKey: string,
      options?: { excludeSuspendedDelivery?: boolean },
    ): number => {
      const root = rootSessionKey.trim();
      if (!getDescendantRuns(root).length) {
        return 0;
      }
      // Admission and display can settle suspended deliveries while cleanup still
      // owns their retained results. Keep the two projections independently cached.
      const counts = options?.excludeSuspendedDelivery
        ? admissionPendingDescendantCountBySessionKey
        : pendingDescendantCountBySessionKey;
      if (counts.has(root)) {
        return counts.get(root) ?? 0;
      }
      const count = countPendingDescendantRunsInternal(root, options);
      counts.set(root, count);
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

    const listDescendantRunsForRequester = (rootSessionKey: string): T[] => [
      ...getDescendantRuns(rootSessionKey),
    ];

    return {
      inputs,
      revision: topology.revision,
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
export function getLatestSubagentRunByChildSessionKeyFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T> | Iterable<T>,
  childSessionKey: string,
  matches?: (entry: T) => boolean,
  childAgentId?: string,
): T | undefined {
  const key = childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  return latestSubagentRun(
    runs instanceof Map ? runs.values() : runs,
    (entry) =>
      matchesSubagentChildSessionOwner(entry, key, childAgentId) && (!matches || matches(entry)),
  );
}

/** Admission prefers a retained active run, then the latest generation. */
export function getSubagentRunByChildSessionKeyFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  childSessionKey: string,
  childAgentId?: string,
  liveRuns?: ReadonlyMap<string, SubagentRunRecord>,
): T | null {
  return (
    getLatestSubagentRunByChildSessionKeyFromRuns(
      runs,
      childSessionKey,
      (entry) => {
        const live = liveRuns?.get(entry.runId);
        return isRetainedUnendedSubagentRun(live && isSameSubagentRun(live, entry) ? live : entry);
      },
      childAgentId,
    ) ??
    getLatestSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey, undefined, childAgentId) ??
    null
  );
}

/** Latest run for a record's child session, scoped to the owner that record captured. */
export function getLatestSubagentRunForChild(
  runs: Map<string, SubagentRunRecord> | Iterable<SubagentRunRecord>,
  child: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId">,
): SubagentRunRecord | undefined {
  return getLatestSubagentRunByChildSessionKeyFromRuns(
    runs,
    child.childSessionKey,
    undefined,
    child.childAgentId,
  );
}

export function resolveRequesterForChildSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
  childAgentId?: string,
): {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(
    runs,
    childSessionKey,
    undefined,
    childAgentId,
  );
  if (!latest) {
    return null;
  }
  return {
    requesterSessionKey: latest.requesterSessionKey,
    requesterAgentId: latest.requesterAgentId,
    requesterOrigin: latest.requesterOrigin,
  };
}

export function shouldIgnorePostCompletionAnnounceForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  const latest = getLatestSubagentRunByChildSessionKeyFromRuns(
    runs,
    childSessionKey,
    undefined,
    childAgentId,
  );
  return Boolean(
    latest &&
    latest.spawnMode !== "session" &&
    typeof latest.execution.endedAt === "number" &&
    typeof latest.cleanupCompletedAt === "number" &&
    latest.cleanupCompletedAt >= latest.execution.endedAt,
  );
}

export function listSwarmRunsForGroupFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  groupId: string,
  requesterSessionKey?: string,
  requesterAgentId?: string,
): T[] {
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
export function countActiveRunsForSessionFromRuns<T extends SubagentRunReadRecord>(
  runs: Map<string, T>,
  controllerSessionKey: string,
  options?: { collect?: boolean; requesterAgentId?: string },
): number {
  const key = controllerSessionKey.trim();
  if (!key) {
    return 0;
  }

  const now = Date.now();
  let readIndex: SubagentRunReadIndex<T> | undefined;

  const latestByChildSessionKey = new Map<string, T>();
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
    if (
      readIndex.countPendingDescendantRuns(entry.childSessionKey, {
        excludeSuspendedDelivery: true,
      }) > 0
    ) {
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

export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  return buildSubagentRunReadIndexFromRuns({ runs }).listDescendantRunsForRequester(rootSessionKey);
}
