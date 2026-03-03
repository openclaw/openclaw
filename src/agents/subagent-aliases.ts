import { normalizeAgentId } from "../routing/session-key.js";

const SUBAGENT_AGENT_ALIASES: Record<string, string> = {
  kissinger: "catering_pipeline_builder",
  friedman: "cost_controller",
  olivetti: "capacity_controller",
};

export function resolveSubagentAgentAlias(agentId: string): string {
  const normalized = normalizeAgentId(agentId);
  return SUBAGENT_AGENT_ALIASES[normalized] ?? normalized;
}

export function aliasesForCanonicalAgentId(agentId: string): string[] {
  const canonical = normalizeAgentId(agentId);
  return Object.entries(SUBAGENT_AGENT_ALIASES)
    .filter(([, target]) => normalizeAgentId(target) === canonical)
    .map(([alias]) => alias)
    .toSorted((a, b) => a.localeCompare(b));
}
