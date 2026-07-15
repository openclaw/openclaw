import { normalizeQaProviderMode, type QaProviderModeInput } from "../../run-config.js";
import type { MatrixQaConfigOverrides } from "../../substrate/config.js";
import { resolveMatrixQaModels, type ResolvedMatrixQaModels } from "./model-selection.js";
import { MATRIX_QA_SCENARIOS } from "./scenarios.js";

type MatrixQaScheduledScenario = {
  originalIndex: number;
  scenario: (typeof MATRIX_QA_SCENARIOS)[number];
};

export function buildMatrixQaGatewayConfigKey(params: {
  models?: ResolvedMatrixQaModels;
  overrides?: MatrixQaConfigOverrides;
  providerModeKey?: string;
}) {
  return JSON.stringify({
    models: params.models
      ? {
          alternateModel: params.models.alternateModel,
          primaryModel: params.models.primaryModel,
          providerMode: params.models.providerMode,
        }
      : undefined,
    overrides: params.overrides ?? null,
    providerModeKey: params.providerModeKey,
  });
}

const MATRIX_QA_EXECUTION_TAIL_SCENARIO_IDS = new Set(["matrix-e2ee-wrong-account-recovery-key"]);

export function scheduleMatrixQaScenariosInCatalogOrder(
  scenarios: readonly (typeof MATRIX_QA_SCENARIOS)[number][],
): MatrixQaScheduledScenario[] {
  const entries = scenarios.map((scenario, originalIndex) => ({ originalIndex, scenario }));
  const groupedEntries: MatrixQaScheduledScenario[][] = [];
  const groupIndexes = new Map<string, number>();
  const tailEntries: MatrixQaScheduledScenario[] = [];

  for (const entry of entries) {
    if (MATRIX_QA_EXECUTION_TAIL_SCENARIO_IDS.has(entry.scenario.id)) {
      tailEntries.push(entry);
      continue;
    }
    const key = buildMatrixQaGatewayConfigKey({
      overrides: entry.scenario.configOverrides,
      providerModeKey: entry.scenario.providerMode ?? "suite",
    });
    const existingIndex = groupIndexes.get(key);
    if (existingIndex !== undefined) {
      groupedEntries[existingIndex]?.push(entry);
      continue;
    }
    groupIndexes.set(key, groupedEntries.length);
    groupedEntries.push([entry]);
  }

  return [...groupedEntries.flat(), ...tailEntries];
}

export function selectMatrixQaCanaryProviderMode(
  scheduledScenarios: readonly MatrixQaScheduledScenario[],
): QaProviderModeInput | undefined {
  let selectedProviderMode: QaProviderModeInput | undefined;
  for (const { scenario } of scheduledScenarios) {
    if (!scenario.providerMode) {
      return undefined;
    }
    if (!selectedProviderMode) {
      selectedProviderMode = scenario.providerMode;
      continue;
    }
    if (scenario.providerMode !== selectedProviderMode) {
      return undefined;
    }
  }
  return selectedProviderMode;
}

export function resolveMatrixQaGatewayModels(params: {
  defaultModels: ResolvedMatrixQaModels;
  providerMode?: QaProviderModeInput;
}): ResolvedMatrixQaModels {
  if (!params.providerMode) {
    return params.defaultModels;
  }
  const providerMode = normalizeQaProviderMode(params.providerMode);
  return providerMode === params.defaultModels.providerMode
    ? params.defaultModels
    : resolveMatrixQaModels({ providerMode });
}

export function getMatrixQaScenarioRestartReadyTimeoutMs(scenario: { timeoutMs: number }): number {
  return scenario.timeoutMs;
}
