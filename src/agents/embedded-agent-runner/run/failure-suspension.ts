import type { SessionSuspensionParams } from "../../session-suspension.js";

export function buildEmbeddedFailureSuspension(params: {
  suspension: SessionSuspensionParams;
  runAgentId?: string;
}): SessionSuspensionParams {
  return {
    ...params.suspension,
    // A caller-supplied id wins; the run id only fills the gap so an
    // unregistered agentDir cannot fall back to the default agent's store.
    agentId: params.suspension.agentId ?? params.runAgentId,
  };
}
