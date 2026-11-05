import type { QaProviderMode } from "./model-selection.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaSuiteRunParams } from "./suite-types.js";

export function partitionSharedQaFlowScenarios(
  scenarios: readonly QaSeedScenarioWithSource[],
  concurrency: number,
  maxPartitions: number,
) {
  const partitionCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, Math.floor(maxPartitions)),
    scenarios.length,
  );
  const partitions = Array.from({ length: partitionCount }, (): QaSeedScenarioWithSource[] => []);
  for (const [index, scenario] of scenarios.entries()) {
    const partition = partitions[index % partitionCount];
    if (!partition) {
      throw new Error("failed to partition shared QA flow scenarios");
    }
    partition.push(scenario);
  }
  return partitions.filter((partition) => partition.length > 0);
}

export function scenarioDeclaresQaRuntimeRoute(scenario: QaSeedScenarioWithSource) {
  return (
    scenario.execution.kind === "flow" &&
    (scenario.execution.runtime !== undefined ||
      scenario.execution.liveConfiguredRuntime !== undefined)
  );
}

export function resolveQaScenarioRuntimeRoute(
  scenario: QaSeedScenarioWithSource,
  providerMode: QaProviderMode,
  selection: Pick<
    QaSuiteRunParams,
    "primaryModel" | "alternateModel" | "forcedRuntime" | "runtimePair"
  > = {},
) {
  if (scenario.execution.kind !== "flow") {
    return [];
  }
  const configured = scenario.execution.liveConfiguredRuntime;
  // This opt-in proof route belongs to the scenario's selected model pair.
  // General models and explicitly forced/parity cells retain their own routes.
  const configuredRuntime =
    providerMode === "live-frontier" &&
    !selection.forcedRuntime &&
    !selection.runtimePair &&
    configured?.model === selection.primaryModel &&
    configured?.model === selection.alternateModel
      ? configured?.id
      : undefined;
  const runtime = configuredRuntime ?? scenario.execution.runtime;
  return runtime
    ? [
        {
          runtime,
          runtimeSelection: configuredRuntime ? ("configured" as const) : ("forced" as const),
          scenario,
        },
      ]
    : [];
}
