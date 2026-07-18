/**
 * Process-local live subagent run map.
 *
 * Shared by registry read/write helpers for active in-memory run state.
 */
import { isDeepStrictEqual } from "node:util";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const subagentRuns = new Map<string, SubagentRunRecord>();

/** Resolve a collector tombstone that reserves its child session from ordinary turns. */
export function findSwarmCollectorSession(childSessionKey?: string): SubagentRunRecord | undefined {
  const key = childSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return [...subagentRuns.values()].find(
    (entry) => entry.collect === true && entry.childSessionKey === key,
  );
}

/** Resolve the host-registered collector that authorizes a Gateway request. */
export function findAuthorizedSwarmCollectorRequest(params: {
  childSessionKey?: string;
  idempotencyKey?: string;
  outputSchema?: Record<string, unknown>;
}): SubagentRunRecord | undefined {
  const childSessionKey = params.childSessionKey?.trim();
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!childSessionKey || !idempotencyKey) {
    return undefined;
  }
  return [...subagentRuns.values()].find(
    (entry) =>
      entry.collect === true &&
      entry.childSessionKey === childSessionKey &&
      entry.swarmLaunchIdempotencyKey === idempotencyKey &&
      isDeepStrictEqual(entry.outputSchema, params.outputSchema),
  );
}
