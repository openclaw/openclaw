import { runEmbeddedAttempt } from "../pi-embedded-runner/run/attempt.js";
import { applyAgentHarnessResultClassification } from "./result-classification.js";
import type { AgentHarness } from "./types.js";
import { registerNativeAgentHarnessV2Factory, type AgentHarnessV2 } from "./v2.js";

export const PI_AGENT_HARNESS_ID = "pi";
export const PI_AGENT_HARNESS_LABEL = "PI embedded agent";

export function createPiAgentHarness(): AgentHarness {
  return {
    id: PI_AGENT_HARNESS_ID,
    label: PI_AGENT_HARNESS_LABEL,
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
  };
}

/**
 * Native AgentHarnessV2 for the built-in PI embedded runner. This cleanup
 * package keeps the lifecycle methods bottoming out in `runEmbeddedAttempt`,
 * so the visible AgentHarnessAttemptResult remains identical to the V1-adapter
 * path. Follow-up structural PRs can plumb prepare/start/cleanup through split
 * lifecycle modules once those seams exist.
 */
export function createPiAgentHarnessV2(harness: AgentHarness): AgentHarnessV2 {
  return {
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
    supports: (ctx) => harness.supports(ctx),
    prepare: async (params) => ({
      harnessId: harness.id,
      label: harness.label,
      pluginId: harness.pluginId,
      params,
      lifecycleState: "prepared",
    }),
    start: async (prepared) => ({
      harnessId: prepared.harnessId,
      label: prepared.label,
      pluginId: prepared.pluginId,
      params: prepared.params,
      lifecycleState: "started",
    }),
    send: async (session) => harness.runAttempt(session.params),
    resolveOutcome: async (session, result) =>
      applyAgentHarnessResultClassification(harness, result, session.params),
    cleanup: async (_params) => {
      // Cleanup remains intentionally empty so the native AgentHarnessV2 path
      // and the V1-adapter path stay observationally identical. A future pass
      // may route lifecycle cleanup through a dedicated subscription-cleanup
      // helper once the stream-loop extraction lands.
    },
    compact: harness.compact ? (params) => harness.compact!(params) : undefined,
    reset: harness.reset ? (params) => harness.reset!(params) : undefined,
    dispose: harness.dispose ? () => harness.dispose!() : undefined,
  };
}

registerNativeAgentHarnessV2Factory(PI_AGENT_HARNESS_ID, createPiAgentHarnessV2);
