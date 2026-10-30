import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

const QA_AGENTIC_PARITY_PACK = "agentic";

const QA_AGENTIC_PARITY_SCENARIOS = [
  ["approval-turn-tool-followthrough", "Approval turn tool followthrough", true],
  ["model-switch-tool-continuity", "Model switch with tool continuity", true],
  ["source-docs-discovery-report", "Source and docs discovery report", true],
  ["image-understanding-attachment", "Image understanding from attachment", false],
  ["compaction-retry-mutating-tool", "Compaction retry after mutating tool", true],
  ["subagent-handoff", "Subagent handoff", true],
  ["subagent-fanout-synthesis", "Subagent fanout synthesis", true],
  ["subagent-stale-child-links", "Subagent stale child links", false],
  ["memory-recall", "Memory recall after context switch", false],
  ["thread-memory-isolation", "Thread memory isolation", true],
  ["config-restart-capability-flip", "Config restart capability flip", true],
  ["instruction-followthrough-repo-contract", "Instruction followthrough repo contract", true],
] as const satisfies ReadonlyArray<
  readonly [id: string, title: string, countsTowardValidToolCallRate: boolean]
>;

const QA_AGENTIC_PARITY_SCENARIO_IDS = QA_AGENTIC_PARITY_SCENARIOS.map(([id]) => id);
export const QA_AGENTIC_PARITY_SCENARIO_TITLES = QA_AGENTIC_PARITY_SCENARIOS.map(
  ([, title]) => title,
);
export const QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES = QA_AGENTIC_PARITY_SCENARIOS.filter(
  (scenario) => scenario[2],
).map(([, title]) => title);

export function resolveQaParityPackScenarioIds(params: {
  parityPack?: string;
  scenarioIds?: string[];
}): string[] {
  const normalizedPack = params.parityPack?.trim().toLowerCase();
  const explicitScenarioIds = uniqueStrings(params.scenarioIds ?? []);
  if (!normalizedPack) {
    return explicitScenarioIds;
  }
  if (normalizedPack !== QA_AGENTIC_PARITY_PACK) {
    throw new Error(
      `--parity-pack must be "${QA_AGENTIC_PARITY_PACK}", got "${params.parityPack}"`,
    );
  }

  return uniqueStrings([...explicitScenarioIds, ...QA_AGENTIC_PARITY_SCENARIO_IDS]);
}
