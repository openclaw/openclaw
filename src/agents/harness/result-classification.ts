import type {
  AgentHarness,
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
} from "./types.js";

/** Applies a harness classifier while replacing any stale prior classification. */
export function applyAgentHarnessResultClassification(
  harness: Pick<AgentHarness, "id" | "classify">,
  result: AgentHarnessAttemptResult,
  params: AgentHarnessAttemptParamsV2,
): AgentHarnessAttemptResult {
  if (!harness.classify) {
    return { ...result, agentHarnessId: harness.id };
  }
  // Reclassify from the raw result so retries or wrappers cannot preserve an
  // obsolete classification from an earlier harness.
  const { agentHarnessResultClassification: _previousClassification, ...resultWithoutPrevious } =
    result;
  const classification = harness.classify(resultWithoutPrevious, params);
  return {
    ...resultWithoutPrevious,
    agentHarnessId: harness.id,
    ...(classification && classification !== "ok"
      ? { agentHarnessResultClassification: classification }
      : {}),
  };
}
