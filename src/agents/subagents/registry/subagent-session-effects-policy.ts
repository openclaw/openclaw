import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Session effects stay with the admitted child incarnation and current cancellation owner. */
export function shouldSuppressSubagentSessionEffects(entry: SubagentRunRecord): boolean {
  if (
    subagentRuns.isCompletionAuthorityRetired(entry) ||
    resolveSubagentChildAuthority(entry).status !== "verified" ||
    entry.execution.suppressSessionEffects === true
  ) {
    return true;
  }
  if (!entry.killIntent) {
    return false;
  }
  const generation = entry.killIntent.lifecycleGeneration;
  return !generation || !isAgentEventLifecycleGenerationCurrent(generation);
}
