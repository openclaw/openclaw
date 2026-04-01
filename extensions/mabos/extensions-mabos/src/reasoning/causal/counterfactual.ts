/**
 * Counterfactual Reasoning Tool
 *
 * Performs what-if analysis by exploring alternative scenarios
 * and reasoning about how different conditions would have led
 * to different outcomes.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const CounterfactualParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  actual: Type.String({ description: "What actually happened" }),
  counterfactual: Type.String({ description: "What-if scenario" }),
  variables: Type.Optional(Type.Array(Type.String(), { description: "Variables affected" })),
});

export function createCounterfactualTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_counterfactual",
    label: "Counterfactual Reasoning",
    description: "What-if analysis: explore alternative scenarios and their implications.",
    parameters: CounterfactualParams,
    async execute(_id: string, params: Static<typeof CounterfactualParams>) {
      return textResult(`## Counterfactual Analysis — ${params.agent_id}

**Actual:** ${params.actual}
**What if:** ${params.counterfactual}
${params.variables?.length ? `**Variables affected:** ${params.variables.join(", ")}` : ""}

Analyze:
1. What causal chain led to the actual outcome?
2. How would the counterfactual change that chain?
3. What downstream effects would differ?
4. Confidence in the counterfactual outcome?
5. Key uncertainties?`);
    },
  };
}
