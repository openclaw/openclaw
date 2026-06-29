import type { InputProvenance } from "../sessions/input-provenance.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";

/**
 * Classifier for the subagent-completion announce delivery handoff.
 *
 * A subagent completion is delivered by waking the parent/requester session with
 * the frozen child output as an `inter_session` turn tagged `subagent_announce`.
 * That turn must relay the completion, not act on it: it runs tool-free so a
 * child completion can never drive parent-topic `bash`/`apply_patch`. This is
 * the single predicate that selects the constrained path; both tool gating and
 * prompt-persistence suppression key off it so they cannot drift apart.
 */
export function isSubagentAnnounceCompletionHandoff(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}): boolean {
  if (
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_announce"
  ) {
    return false;
  }
  return (
    params.internalEvents?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    ) === true
  );
}
