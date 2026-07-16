// Qa Lab helper module supports suite test helpers behavior.
import type { QaTransportPolicy } from "./qa-transport.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

type QaSuiteTestScenario = ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];

export function makeQaSuiteTestScenario(
  id: string,
  params: {
    channel?: string;
    driver?: QaSuiteTestScenario["execution"]["driver"];
    config?: Record<string, unknown>;
    plugins?: string[];
    gatewayConfigPatch?: Record<string, unknown>;
    gatewayRuntime?: { forwardHostHome?: boolean; preserveDebugArtifacts?: boolean };
    runtimeParityTier?: QaSuiteTestScenario["runtimeParityTier"];
    suiteIsolation?: "isolated";
    surface?: string;
    transportPolicy?: QaTransportPolicy;
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
      ...(params.channel ? { channel: params.channel } : {}),
      ...(params.driver ? { driver: params.driver } : {}),
      ...(params.suiteIsolation ? { suiteIsolation: params.suiteIsolation } : {}),
      ...(params.transportPolicy ? { transportPolicy: params.transportPolicy } : {}),
      ...(params.config ? { config: params.config } : {}),
      flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
    },
  } as QaSuiteTestScenario;
}
