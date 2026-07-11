/**
 * Read-only subagent registry accessors.
 *
 * Combines persisted snapshots with in-memory live runs for UI, announce, control, and recovery paths.
 */
import { getAgentRunContext } from "../infra/agent-events.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  buildSubagentRunReadIndexFromRuns,
  countActiveDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  SUBAGENT_HEALTH_STALE_AFTER_MS,
  classifySubagentHealth,
  type SubagentHealth,
} from "./subagent-health.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

/** Builds a reusable read index from the current persisted and in-memory run state. */
export function buildSubagentRunReadIndex(now = Date.now()): SubagentRunReadIndex {
  return buildSubagentRunReadIndexFromRuns({
    runs: getSubagentRunsSnapshotForRead(subagentRuns),
    inMemoryRuns: subagentRuns.values(),
    now,
  });
}

/** Lists runs controlled by a session key. */
export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

/** Counts active descendant runs for a requester/session tree. */
export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** Lists descendant runs under a requester/session tree. */
export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

/** Returns the preferred run for a child session, favoring active over ended runs. */
export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

/** Returns whether a registry entry still has a live agent run context. */
export function isSubagentRunLive(
  entry: Pick<SubagentRunRecord, "runId" | "endedAt"> | null | undefined,
): boolean {
  if (!entry || typeof entry.endedAt === "number") {
    return false;
  }
  return Boolean(getAgentRunContext(entry.runId));
}

/** Returns the run to display for a child session, using live memory before snapshot state. */
export function getSessionDisplaySubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestInMemoryActive: SubagentRunRecord | null = null;
  let latestInMemoryEnded: SubagentRunRecord | null = null;
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      if (!latestInMemoryEnded || compareSubagentRunGeneration(entry, latestInMemoryEnded) > 0) {
        latestInMemoryEnded = entry;
      }
      continue;
    }
    if (!latestInMemoryActive || compareSubagentRunGeneration(entry, latestInMemoryActive) > 0) {
      latestInMemoryActive = entry;
    }
  }

  if (latestInMemoryEnded || latestInMemoryActive) {
    // Fresh in-memory terminal state is more accurate than an older active snapshot row.
    if (
      latestInMemoryEnded &&
      (!latestInMemoryActive ||
        compareSubagentRunGeneration(latestInMemoryEnded, latestInMemoryActive) > 0)
    ) {
      return latestInMemoryEnded;
    }
    return latestInMemoryActive ?? latestInMemoryEnded;
  }

  return getSubagentRunByChildSessionKey(key);
}

function getSubagentRunForTask(
  task: TaskRecord,
  runs: Map<string, SubagentRunRecord> = getSubagentRunsSnapshotForRead(subagentRuns),
): SubagentRunRecord | null {
  if (task.runtime !== "subagent") {
    return null;
  }
  if (task.runId) {
    const exact = runs.get(task.runId);
    if (exact) {
      return exact;
    }
  }
  return task.childSessionKey
    ? getSubagentRunByChildSessionKeyFromRuns(runs, task.childSessionKey)
    : null;
}

export function createSubagentHealthResolver(
  now = Date.now(),
): (task: TaskRecord) => SubagentHealth | undefined {
  const runs = getSubagentRunsSnapshotForRead(subagentRuns);
  return (task) => {
    const run = getSubagentRunForTask(task, runs);
    if (!run) {
      return undefined;
    }
    return classifySubagentHealth({
      run,
      task,
      now,
      staleAfterMs: SUBAGENT_HEALTH_STALE_AFTER_MS,
    });
  };
}

/** Returns the current diagnostic health for a subagent-backed task. */
export function resolveSubagentHealthForTask(
  task: TaskRecord,
  now = Date.now(),
): SubagentHealth | undefined {
  return createSubagentHealthResolver(now)(task);
}

/** Returns the most recently created run for a child session from readable registry state. */
export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || compareSubagentRunGeneration(entry, latest) > 0) {
      latest = entry;
    }
  }

  return latest;
}
