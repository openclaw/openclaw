import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessResultClassification,
} from "./types.js";

export function applyAgentHarnessResultClassification(
  harness: Pick<AgentHarness, "id" | "classify">,
  result: AgentHarnessAttemptResult,
  params: AgentHarnessAttemptParams,
): AgentHarnessAttemptResult {
  const { agentHarnessResultClassification: _previousClassification, ...resultWithoutPrevious } =
    result;
  const classification = harness.classify?.(result, params);
  if (!classification || classification === "ok") {
    return { ...resultWithoutPrevious, agentHarnessId: harness.id };
  }
  return {
    ...resultWithoutPrevious,
    agentHarnessId: harness.id,
    agentHarnessResultClassification: classification as Exclude<
      AgentHarnessResultClassification,
      "ok"
    >,
  };
}
