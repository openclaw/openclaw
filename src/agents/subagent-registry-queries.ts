import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function findRunIdsByChildSessionKeyFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): string[] {
  const key = childSessionKey.trim();
  if (!key) {
    return [];
  }
  const runIds: string[] = [];
  for (const [runId, entry] of runs.entries()) {
    if (entry.childSessionKey === key) {
      runIds.push(runId);
    }
  }
  return runIds;
}

export function listRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...runs.values()].filter((entry) => entry.requesterSessionKey === key);
}

export function resolveRequesterForChildSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  let best: SubagentRunRecord | undefined;
  for (const entry of runs.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!best || entry.createdAt > best.createdAt) {
      best = entry;
    }
  }
  if (!best) {
    return null;
  }
  return {
    requesterSessionKey: best.requesterSessionKey,
    requesterOrigin: best.requesterOrigin,
  };
}

export function countActiveRunsForSessionFromRuns(
  runs: Map<string, SubagentRunRecord>,
  requesterSessionKey: string,
): number {
  const key = requesterSessionKey.trim();
  if (!key) {
    return 0;
  }
  let count = 0;
  for (const entry of runs.values()) {
    if (entry.requesterSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    count += 1;
  }
  return count;
}

function forEachDescendantRun(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  visitor: (runId: string, entry: SubagentRunRecord) => void,
): boolean {
  const root = rootSessionKey.trim();
  if (!root) {
    return false;
  }
  const pending = [root];
  const visited = new Set<string>([root]);
  for (let index = 0; index < pending.length; index += 1) {
    const requester = pending[index];
    if (!requester) {
      continue;
    }
    for (const [runId, entry] of runs.entries()) {
      if (entry.requesterSessionKey !== requester) {
        continue;
      }
      visitor(runId, entry);
      const childKey = entry.childSessionKey.trim();
      if (!childKey || visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      pending.push(childKey);
    }
  }
  return true;
}

export function countActiveDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      if (typeof entry.endedAt !== "number") {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

function countPendingDescendantRunsInternal(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId?: string,
): number {
  const excludedRunId = excludeRunId?.trim();
  let count = 0;
  if (
    !forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
      const runEnded = typeof entry.endedAt === "number";
      const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
      if ((!runEnded || !cleanupCompleted) && runId !== excludedRunId) {
        count += 1;
      }
    })
  ) {
    return 0;
  }
  return count;
}

export function countPendingDescendantRunsFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey);
}

export function countPendingDescendantRunsExcludingRunFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId);
}

export function listDescendantRunsForRequesterFromRuns(
  runs: Map<string, SubagentRunRecord>,
  rootSessionKey: string,
): SubagentRunRecord[] {
  const descendants: SubagentRunRecord[] = [];
  if (
    !forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
      descendants.push(entry);
    })
  ) {
    return [];
  }
  return descendants;
}
