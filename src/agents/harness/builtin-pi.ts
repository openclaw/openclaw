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
 * Native AgentHarnessV2 for the built-in PI embedded runner. At PR 2 (RFC 72072)
 * the lifecycle methods still bottom out in `runEmbeddedAttempt`, so the
 * visible AgentHarnessAttemptResult must remain identical to the V1-adapter
 * path. PR 4 is where prepare/start/cleanup will plumb through the split
 * lifecycle modules.
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
      // PR 4 will route lifecycle cleanup through
      // `attempt.subscription-cleanup.ts` here. PR 2 keeps cleanup intentionally
      // empty so native and V1-adapter paths stay observationally identical.
    },
    compact: harness.compact ? (params) => harness.compact!(params) : undefined,
    reset: harness.reset ? (params) => harness.reset!(params) : undefined,
    dispose: harness.dispose ? () => harness.dispose!() : undefined,
  };
}

registerNativeAgentHarnessV2Factory(PI_AGENT_HARNESS_ID, createPiAgentHarnessV2);
