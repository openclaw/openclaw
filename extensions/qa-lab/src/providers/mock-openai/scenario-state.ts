import type { MockScenarioState } from "./mock-openai-contracts.js";

export function createQaMockScenarioStateStore() {
  const scenarioStates = new Map<string, MockScenarioState>();
  return (sessionId = ""): MockScenarioState => {
    // Transport identity survives prompt edits, provider switches, and cache boundaries.
    const state = scenarioStates.get(sessionId) ?? {
      anthropicThinkingErrorScenarioKeys: new Set<string>(),
      compactionOverflowInjected: false,
      compactionRetryActive: false,
      subagentFanoutCompletedWorkers: new Set<"alpha" | "beta">(),
      subagentFanoutPhase: 0,
      subagentHandoffSpawned: false,
      repeatedRequestRecoveryAttempts: 0,
      toolLoopReadAttempts: 0,
    };
    scenarioStates.set(sessionId, state);
    return state;
  };
}
