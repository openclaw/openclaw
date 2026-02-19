/**
 * Causal Reasoning Tool
 *
 * Evaluates candidate causes for an observed effect using structured
 * causal analysis criteria: temporal precedence, mechanism plausibility,
 * confounders, strength of association, and consistency with observations.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const CausalParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  effect: Type.String({ description: "Observed effect to explain" }),
  candidate_causes: Type.Array(Type.String(), { description: "Candidate causes" }),
  observations: Type.Optional(
    Type.Array(Type.String(), { description: "Additional observations" }),
  ),
});

export function createCausalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_causal",
    label: "Causal Reasoning",
    description:
      "Identify cause-effect relationships and evaluate candidate causes for an observed effect.",
    parameters: CausalParams,
    async execute(_id: string, params: Static<typeof CausalParams>) {
      const candidates = params.candidate_causes.map((c, i) => `${i + 1}. ${c}`).join("\n");
      return textResult(`## Causal Analysis — ${params.agent_id}

**Effect:** ${params.effect}

**Candidate Causes:**
${candidates}

${params.observations?.length ? `**Observations:** ${params.observations.join("; ")}` : ""}

For each candidate, evaluate:
1. Temporal precedence (did it occur before the effect?)
2. Mechanism (how would it cause the effect?)
3. Confounders (alternative explanations?)
4. Strength of association
5. Consistency with observations

Rank candidates by causal plausibility.`);
    },
  };
}
