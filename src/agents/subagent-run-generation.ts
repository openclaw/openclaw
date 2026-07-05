import type { SubagentRunRecord } from "./subagent-registry.types.js";

function normalizeGeneration(entry: SubagentRunRecord): number {
  return typeof entry.generation === "number" && Number.isFinite(entry.generation)
    ? entry.generation
    : 0;
}

/** Orders runs that share a child session, including legacy rows without a generation. */
export function compareSubagentRunGeneration(
  left: SubagentRunRecord,
  right: SubagentRunRecord,
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

/** Allocates a durable monotonic generation within one child session. */
export function nextSubagentRunGeneration(
  runs: Iterable<SubagentRunRecord>,
  childSessionKey: string,
): number {
  let generation = 0;
  for (const entry of runs) {
    if (entry.childSessionKey === childSessionKey) {
      generation = Math.max(generation, normalizeGeneration(entry));
    }
  }
  return generation + 1;
}
