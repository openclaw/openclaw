/**
 * Inductive Reasoning Tool
 *
 * Generalizes from specific observations to broader conclusions.
 * Unlike deduction, inductive conclusions are probable, not certain.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const InductiveParams = Type.Object({
  observations: Type.Array(Type.String(), {
    description: "Specific observations or data points to generalize from",
  }),
  hypothesis: Type.Optional(
    Type.String({
      description: "Optional hypothesis to test against the observations",
    }),
  ),
  domain: Type.Optional(
    Type.String({
      description:
        "Domain context to guide the generalization (e.g., 'software engineering', 'finance')",
    }),
  ),
});

export function createInductiveTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_inductive",
    label: "Inductive Reasoning",
    description:
      "Generalize from specific observations to broader conclusions. Identifies patterns and forms probable generalizations.",
    parameters: InductiveParams,
    async execute(_id: string, params: Static<typeof InductiveParams>) {
      const numberedObs = params.observations.map((o, i) => `  ${i + 1}. ${o}`).join("\n");

      const hypothesisSection = params.hypothesis
        ? `\n**Hypothesis to test:** ${params.hypothesis}`
        : "";

      const domainSection = params.domain ? `\n**Domain context:** ${params.domain}` : "";

      return textResult(`## Inductive Reasoning

**Observations:**
${numberedObs}
${hypothesisSection}
${domainSection}

---

**Instructions — apply inductive reasoning systematically:**

1. **Pattern identification:** What recurring patterns, regularities, or trends appear across the observations?
2. **Generalization:** What broader principle or rule could account for all the observations?
3. **Sample assessment:** How representative and diverse are the observations? Are there selection biases?
4. **Counterexample search:** Can you think of plausible counterexamples that would weaken the generalization?
5. **Confidence assessment:**
   - How many observations support the generalization?
   - How varied are the conditions under which they were observed?
   - Are there known exceptions?
${params.hypothesis ? `6. **Hypothesis evaluation:** Does the hypothesis "${params.hypothesis}" align with the observed patterns? What observations support or weaken it?` : "6. **Hypothesis formation:** Propose one or more hypotheses that best explain the observed patterns."}

**Provide:**
- The strongest generalization supported by the data.
- Confidence level: STRONG (many diverse observations, no counterexamples), MODERATE (some support, minor gaps), or WEAK (few observations, possible counterexamples).
- Conditions under which the generalization might fail.`);
    },
  };
}
