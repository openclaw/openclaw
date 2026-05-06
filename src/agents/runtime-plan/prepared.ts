import type { AgentRuntimePreparedFacts, AgentRuntimePreparedRuntimePlan } from "./types";

export function createDefaultPreparedRuntimePlan(): AgentRuntimePreparedRuntimePlan {
  return {
    buildPreparedFacts: () => ({}),
  };
}

export function mergePreparedFacts(
  ...facts: AgentRuntimePreparedFacts[]
): AgentRuntimePreparedFacts {
  const merged: AgentRuntimePreparedFacts = {};

  for (const fact of facts) {
    if (fact.providers) {
      merged.providers = [...(merged.providers ?? []), ...fact.providers];
    }
    if (fact.models) {
      merged.models = [...(merged.models ?? []), ...fact.models];
    }
    if (fact.channels) {
      merged.channels = [...(merged.channels ?? []), ...fact.channels];
    }
    if (fact.media) {
      merged.media = [...(merged.media ?? []), ...fact.media];
    }
    if (fact.speech) {
      merged.speech = [...(merged.speech ?? []), ...fact.speech];
    }
  }

  return merged;
}

export function isEmptyPreparedFacts(facts: AgentRuntimePreparedFacts): boolean {
  return !facts.providers && !facts.models && !facts.channels && !facts.media && !facts.speech;
}
