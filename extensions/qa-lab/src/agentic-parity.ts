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

  return [...new Set([...explicitScenarioIds, ...QA_AGENTIC_PARITY_SCENARIO_IDS])];
}
