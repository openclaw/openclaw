import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";

export const QA_AGENTIC_PARITY_PACK = "agentic";

export const QA_AGENTIC_PARITY_SCENARIO_IDS = [
  "approval-turn-tool-followthrough",
  "model-switch-tool-continuity",
  "source-docs-discovery-report",
  "image-understanding-attachment",
] as const;

export function resolveQaParityPackScenarioIds(params: {
  parityPack?: string;
  scenarioIds?: string[];
}): string[] {
  const normalizedPack = params.parityPack?.trim().toLowerCase();
  const explicitScenarioIds = [...new Set(params.scenarioIds ?? [])];
  if (!normalizedPack) {
    return explicitScenarioIds;
  }
  if (normalizedPack !== QA_AGENTIC_PARITY_PACK) {
    throw new Error(
      `--parity-pack must be "${QA_AGENTIC_PARITY_PACK}", got "${params.parityPack}"`,
    );
  }

  const availableScenarioIds = new Set(
    readQaBootstrapScenarioCatalog().scenarios.map((scenario) => scenario.id),
  );
  const missingScenarioIds = QA_AGENTIC_PARITY_SCENARIO_IDS.filter(
    (scenarioId) => !availableScenarioIds.has(scenarioId),
  );
  if (missingScenarioIds.length > 0) {
    throw new Error(
      `qa parity pack references missing scenarios: ${missingScenarioIds.join(", ")}`,
    );
  }

  return [...new Set([...explicitScenarioIds, ...QA_AGENTIC_PARITY_SCENARIO_IDS])];
}
