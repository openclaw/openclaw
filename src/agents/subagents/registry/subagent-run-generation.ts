import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";

type ComparableSubagentRun = {
  runId: string;
  createdAt: number;
  generation?: number;
};

type GenerationalSubagentRun = ComparableSubagentRun & {
  childSessionKey?: string;
  childAgentId?: string;
};

export type SubagentRunIdentity = GenerationalSubagentRun & {
  collect?: boolean;
  swarmRunId?: string;
  schedulerSlotId?: string;
  taskRunId?: string;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterStorePath?: string;
};

/** Durable execution identity is independent of the host runtime incarnation. */
export function getSubagentRunIdentity(entry: SubagentRunIdentity): string {
  return JSON.stringify([
    entry.runId,
    entry.taskRunId ?? entry.runId,
    normalizeGeneration(entry),
    entry.createdAt,
    entry.childSessionKey,
    entry.childAgentId,
    entry.requesterSessionKey,
    entry.requesterAgentId,
    entry.requesterStorePath,
  ]);
}

export function isSameSubagentRun(
  current: SubagentRunIdentity | undefined | null,
  expected: SubagentRunIdentity | undefined | null,
): boolean {
  return Boolean(
    current && expected && getSubagentRunIdentity(current) === getSubagentRunIdentity(expected),
  );
}

const runtimeKeys = new WeakMap<object, object>();

/** A host execution incarnation survives metadata copies, but not Gateway recovery adoption. */
export function getSubagentRunRuntimeKey(entry: object): object {
  let key = runtimeKeys.get(entry);
  if (!key) {
    key = {};
    runtimeKeys.set(entry, key);
  }
  return key;
}

/** Row producers associate aliases before retaining them or publishing an immutable copy. */
export function bindSubagentRunRuntimeKey(entry: object, key: object): void {
  runtimeKeys.set(entry, key);
}

/** Hydration keeps an existing host incarnation unless its producer supplied a fresh one. */
export function retainSubagentRunRuntimeOwner(
  current: SubagentRunIdentity | undefined,
  next: SubagentRunIdentity,
): void {
  if (!runtimeKeys.has(next)) {
    bindSubagentRunRuntimeKey(
      next,
      current && isSameSubagentRun(current, next) ? getSubagentRunRuntimeKey(current) : {},
    );
  }
}

/** Accepted collector launch changes its address, not its queued physical execution. */
export function isQueuedSubagentRunRekey(
  previous: SubagentRunIdentity,
  next: SubagentRunIdentity,
): boolean {
  const alias = previous.swarmRunId ?? previous.runId;
  return (
    previous.runId !== next.runId &&
    previous.collect === true &&
    next.collect === true &&
    next.swarmRunId === alias &&
    (previous.schedulerSlotId ?? alias) === (next.schedulerSlotId ?? next.swarmRunId) &&
    (previous.taskRunId ?? alias) === (next.taskRunId ?? next.swarmRunId) &&
    normalizeGeneration(previous) === normalizeGeneration(next) &&
    previous.createdAt === next.createdAt &&
    previous.childSessionKey === next.childSessionKey &&
    previous.childAgentId === next.childAgentId &&
    previous.requesterSessionKey === next.requesterSessionKey &&
    previous.requesterAgentId === next.requesterAgentId &&
    previous.requesterStorePath === next.requesterStorePath
  );
}

export function isSameSubagentRunOwner(
  current: SubagentRunIdentity | undefined | null,
  expected: SubagentRunIdentity | undefined | null,
): boolean {
  if (!current || !expected) {
    return false;
  }
  const key = runtimeKeys.get(current);
  const shared = current === expected || (key !== undefined && key === runtimeKeys.get(expected));
  return (
    shared &&
    (isSameSubagentRun(current, expected) ||
      isQueuedSubagentRunRekey(expected, current) ||
      isQueuedSubagentRunRekey(current, expected))
  );
}

/** The live row when `observed`'s owner still holds its run id; otherwise `observed` itself. */
export function currentSubagentRunOrObserved<T extends SubagentRunIdentity>(
  runs: ReadonlyMap<string, T>,
  observed: T,
): T {
  const current = runs.get(observed.runId);
  return current && isSameSubagentRunOwner(current, observed) ? current : observed;
}

export function copySubagentRunRuntimeOwner<T extends object>(source: object, copy: T): T {
  bindSubagentRunRuntimeKey(copy, getSubagentRunRuntimeKey(source));
  return copy;
}

function normalizeGeneration(entry: ComparableSubagentRun): number {
  return asFiniteNumber(entry.generation) ?? 0;
}

/** Orders runs that share a child session, including legacy rows without a generation. */
export function compareSubagentRunGeneration(
  left: ComparableSubagentRun,
  right: ComparableSubagentRun,
): number {
  const generationDelta = normalizeGeneration(left) - normalizeGeneration(right);
  if (generationDelta !== 0) {
    return generationDelta;
  }
  const createdAtDelta = left.createdAt - right.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }
  return left.runId.localeCompare(right.runId);
}

/** Keeps the newest generation at the grouping key prepared by the caller. */
export function recordLatestSubagentRun<T extends ComparableSubagentRun>(
  map: Map<string, T>,
  key: string,
  entry: T,
): void {
  const existing = map.get(key);
  if (!existing || compareSubagentRunGeneration(entry, existing) > 0) {
    map.set(key, entry);
  }
}

/** Selects the newest matching generation from an existing group. */
export function latestSubagentRun<T extends ComparableSubagentRun>(
  runs: Iterable<T>,
  matches?: (entry: T) => boolean,
): T | undefined {
  let latest: T | undefined;
  for (const entry of runs) {
    if (
      (!matches || matches(entry)) &&
      (!latest || compareSubagentRunGeneration(entry, latest) > 0)
    ) {
      latest = entry;
    }
  }
  return latest;
}

/** Allocates a durable monotonic generation within one child session. */
export function nextSubagentRunGeneration(
  runs: Iterable<GenerationalSubagentRun>,
  childSessionKey: string,
  childAgentId?: string,
): number {
  let generation = 0;
  for (const entry of runs) {
    if (matchesSubagentChildSessionOwner(entry, childSessionKey, childAgentId)) {
      generation = Math.max(generation, normalizeGeneration(entry));
    }
  }
  return generation + 1;
}
