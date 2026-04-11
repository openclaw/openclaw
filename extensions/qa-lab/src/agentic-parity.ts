export const QA_AGENTIC_PARITY_PACK = "agentic";

export const QA_AGENTIC_PARITY_SCENARIOS = [
  {
    id: "approval-turn-tool-followthrough",
    title: "Approval turn tool followthrough",
  },
  {
    id: "model-switch-tool-continuity",
    title: "Model switch with tool continuity",
  },
  {
    id: "source-docs-discovery-report",
    title: "Source and docs discovery report",
  },
  {
    id: "image-understanding-attachment",
    title: "Image understanding from attachment",
  },
  {
    id: "compaction-retry-mutating-tool",
    title: "Compaction retry after mutating tool",
  },
  {
    id: "subagent-handoff",
    title: "Subagent handoff",
  },
  {
    id: "subagent-fanout-synthesis",
    title: "Subagent fanout synthesis",
  },
  {
    id: "memory-recall",
    title: "Memory recall after context switch",
  },
  {
    id: "thread-memory-isolation",
    title: "Thread memory isolation",
  },
  {
    id: "config-restart-capability-flip",
    title: "Config restart capability flip",
  },
] as const;

export const QA_AGENTIC_PARITY_SCENARIO_IDS = QA_AGENTIC_PARITY_SCENARIOS.map(({ id }) => id);
export const QA_AGENTIC_PARITY_SCENARIO_TITLES = QA_AGENTIC_PARITY_SCENARIOS.map(
  ({ title }) => title,
);

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
