/**
 * Scenario Reasoning Tool
 *
 * Explores multiple scenarios constructed from base assumptions
 * with systematic variations, evaluating each against specified criteria.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const VariationSchema = Type.Object({
  name: Type.String({ description: "Short name for this scenario variation" }),
  changes: Type.Array(Type.String(), {
    description: "Changes applied to the base assumptions for this variation",
  }),
});

const ScenarioParams = Type.Object({
  base_assumptions: Type.Array(Type.String(), {
    description: "Shared baseline assumptions that hold across all scenarios",
  }),
  variations: Type.Array(VariationSchema, {
    description: "Named variations, each describing changes to the baseline",
  }),
  eval_criteria: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Criteria against which to evaluate each scenario (e.g., cost, risk, feasibility)",
    }),
  ),
});

export function createScenarioTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_scenario",
    label: "Scenario Reasoning",
    description:
      "Explore multiple scenarios from shared base assumptions with systematic variations and evaluate each against specified criteria.",
    parameters: ScenarioParams,
    async execute(_id: string, params: Static<typeof ScenarioParams>) {
      const { base_assumptions, variations, eval_criteria } = params;

      const baseSection = base_assumptions.map((a, i) => `  ${i + 1}. ${a}`).join("\n");

      const scenarioSections = variations
        .map((v, idx) => {
          const changes = v.changes.map((c) => `    - ${c}`).join("\n");
          return `### Scenario ${idx + 1}: ${v.name}\n**Changes from baseline:**\n${changes}`;
        })
        .join("\n\n");

      const criteriaSection = eval_criteria?.length
        ? `**Evaluation Criteria:**\n${eval_criteria.map((c) => `  - ${c}`).join("\n")}`
        : "**Evaluation Criteria:** Feasibility, risk, impact, and cost (default)";

      return textResult(`## Scenario Analysis

**Base Assumptions:**
${baseSection}

---

${scenarioSections}

---

${criteriaSection}

---

**Instructions — for each scenario:**

1. **Describe the scenario world:** Given the base assumptions plus the stated changes, what does this scenario look like concretely?
2. **Trace consequences:** What are the first-order and second-order effects of the changes?
3. **Evaluate against criteria:** Score or qualitatively assess each scenario on every criterion.
4. **Identify risks and uncertainties:** What could go wrong? What assumptions are most fragile?
5. **Compare scenarios:** Which scenario performs best overall? Are there trade-offs between criteria?

**Provide a summary table** comparing all scenarios across the evaluation criteria, followed by a recommended scenario with justification.`);
    },
  };
}
