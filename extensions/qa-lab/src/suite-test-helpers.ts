// Qa Lab helper module supports suite test helpers behavior.
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

type QaSuiteTestScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

export function makeQaSuiteTestScenario(
  id: string,
  params: {
<<<<<<< HEAD
    channel?: string;
    config?: Record<string, unknown>;
    plugins?: string[];
    gatewayConfigPatch?: Record<string, unknown>;
    gatewayRuntime?: { forwardHostHome?: boolean; preserveDebugArtifacts?: boolean };
    runtimeParityTier?: QaSuiteTestScenario["runtimeParityTier"];
    suiteIsolation?: "isolated";
=======
    config?: Record<string, unknown>;
    plugins?: string[];
    gatewayConfigPatch?: Record<string, unknown>;
    gatewayRuntime?: { forwardHostHome?: boolean };
    runtimeParityTier?: QaSuiteTestScenario["runtimeParityTier"];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    surface?: string;
  } = {},
): QaSuiteTestScenario {
  return {
    id,
    title: id,
    surface: params.surface ?? "test",
    objective: "test",
    successCriteria: ["test"],
    ...(params.runtimeParityTier ? { runtimeParityTier: params.runtimeParityTier } : {}),
    ...(params.plugins ? { plugins: params.plugins } : {}),
    ...(params.gatewayConfigPatch ? { gatewayConfigPatch: params.gatewayConfigPatch } : {}),
    ...(params.gatewayRuntime ? { gatewayRuntime: params.gatewayRuntime } : {}),
    sourcePath: `qa/scenarios/${id}.yaml`,
    execution: {
      kind: "flow",
<<<<<<< HEAD
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.suiteIsolation ? { suiteIsolation: params.suiteIsolation } : {}),
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      ...(params.config ? { config: params.config } : {}),
      flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
    },
  } as QaSuiteTestScenario;
}
