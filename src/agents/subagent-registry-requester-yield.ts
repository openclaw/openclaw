/** Re-arms durable requester-settle delivery after an explicit yield. */
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resumeRequesterSettleWakeAfterYield(params: {
  requesterSessionKey: string;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  runs: Map<string, SubagentRunRecord>;
  persistOrThrow(): void;
  schedule(runId: string, entry: SubagentRunRecord): void;
}): boolean {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const spawnsByRunId = new Map(
    params.acceptedSessionSpawns.map((spawn) => [spawn.runId, spawn] as const),
  );
  if (!requesterSessionKey || spawnsByRunId.size === 0) {
    return false;
  }

  const entries: SubagentRunRecord[] = [];
  for (const [runId, spawn] of spawnsByRunId) {
    const entry = params.runs.get(runId);
    if (
      !entry ||
      entry.childSessionKey !== spawn.childSessionKey ||
      entry.requesterSessionKey !== requesterSessionKey ||
      typeof entry.endedAt !== "number" ||
      entry.expectsCompletionMessage !== true ||
      entry.delivery?.status !== "delivered"
    ) {
      return false;
    }
    entries.push(entry);
  }

  const firstEntry = entries[0];
  if (!firstEntry) {
    return false;
  }
  const batchRunIds = entries.map((entry) => entry.runId).toSorted();
  const rearmGeneration =
    Math.max(0, ...entries.map((entry) => entry.requesterSettleWake?.rearmGeneration ?? 0)) + 1;
  const previousStates = entries.map((entry) => structuredClone(entry.requesterSettleWake));
  for (const entry of entries) {
    const existing = entry.requesterSettleWake;
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds,
      afterRequesterYield: true,
      rearmGeneration,
      ...(existing?.retireAfterSettle === true ? { retireAfterSettle: true } : {}),
    };
  }
  try {
    params.persistOrThrow();
  } catch (error) {
    entries.forEach((entry, index) => {
      entry.requesterSettleWake = previousStates[index];
    });
    throw error;
  }

  // The caller invokes this only after the yielded requester leaves the active-run map.
  // Frozen exact-turn membership makes one delivered child eligible for a durable wake.
  params.schedule(firstEntry.runId, firstEntry);
  return true;
}
