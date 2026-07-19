import type { ActiveEmbeddedRunSteeringTarget } from "./embedded-agent-runner/runs.js";
/**
 * Process-local live subagent run map.
 *
 * Shared by registry read/write helpers for active in-memory run state.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const subagentRuns = new Map<string, SubagentRunRecord>();

/**
 * Ephemeral parent-attempt capabilities. Weak keys intentionally make gateway
 * restart/restore lose steering authority while leaving durable delivery intact.
 */
export const subagentCompletionSteeringTargets = new WeakMap<
  SubagentRunRecord,
  ActiveEmbeddedRunSteeringTarget
>();
