/**
 * Abductive Reasoning Tool
 *
 * Inference to the best explanation: given observations, determine
 * the most plausible explanation from candidates or by generating new ones.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const AbductiveParams = Type.Object({
  observations: Type.Array(Type.String(), {
    description: "Observations or facts that need explanation",
  }),
  candidate_explanations: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional candidate explanations to evaluate",
    }),
  ),
  domain: Type.Optional(
    Type.String({
      description:
        "Domain context to guide explanation generation (e.g., 'medical diagnosis', 'debugging')",
    }),
  ),
});

export function createAbductiveTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_abductive",
    label: "Abductive Reasoning",
    description:
      "Infer the best explanation for a set of observations. Evaluates candidate explanations or generates new ones using inference to the best explanation.",
    parameters: AbductiveParams,
    async execute(_id: string, params: Static<typeof AbductiveParams>) {
      const numberedObs = params.observations.map((o, i) => `  ${i + 1}. ${o}`).join("\n");

      const candidatesSection = params.candidate_explanations?.length
        ? `\n**Candidate explanations:**\n${params.candidate_explanations.map((c, i) => `  E${i + 1}. ${c}`).join("\n")}`
        : "\n**No candidate explanations provided — generate plausible explanations.**";

      const domainSection = params.domain ? `\n**Domain context:** ${params.domain}` : "";

      return textResult(`## Abductive Reasoning — Inference to the Best Explanation

**Observations to explain:**
${numberedObs}
${candidatesSection}
${domainSection}

---

**Instructions — apply abductive reasoning systematically:**

1. **Coverage:** For each candidate explanation, how many of the observations does it account for? An ideal explanation covers all observations.
2. **Simplicity (Occam's Razor):** Prefer explanations that make fewer assumptions and posit fewer unobserved entities.
3. **Plausibility:** How consistent is each explanation with known background knowledge and domain principles?
4. **Explanatory depth:** Does the explanation merely describe the pattern, or does it identify the underlying mechanism?
5. **Falsifiability:** Does the explanation make testable predictions? What evidence would confirm or disconfirm it?
6. **Competing explanations:** Are there alternative explanations? Could multiple explanations be combined?

**Evaluation matrix for each explanation:**
| Criterion       | Score (1-5) | Notes |
|-----------------|-------------|-------|
| Coverage        |             |       |
| Simplicity      |             |       |
| Plausibility    |             |       |
| Depth           |             |       |
| Falsifiability  |             |       |

**Provide:**
- Ranked list of explanations from most to least plausible.
- The best explanation with justification.
- Suggested tests or evidence that would further discriminate between explanations.`);
    },
  };
}
