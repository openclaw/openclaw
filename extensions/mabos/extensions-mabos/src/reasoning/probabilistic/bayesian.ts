/**
 * Bayesian Reasoning Tool
 *
 * Updates the probability of a hypothesis given new evidence using
 * iterative application of Bayes' theorem:
 *   P(H|E) = P(E|H) * P(H) / P(E)
 *
 * Purely algorithmic — no LLM interpretation needed.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const BayesianParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  hypothesis: Type.String({ description: "Hypothesis to evaluate" }),
  prior: Type.Number({ description: "Prior probability P(H)" }),
  evidence: Type.Array(
    Type.Object({
      description: Type.String(),
      likelihood: Type.Number({ description: "P(E|H)" }),
      marginal: Type.Number({ description: "P(E)" }),
    }),
    { description: "Evidence items with likelihoods" },
  ),
});

export function createBayesianTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_bayesian",
    label: "Bayesian Reasoning",
    description:
      "Update probability of a hypothesis given evidence using Bayes' theorem. Iteratively applies P(H|E) = P(E|H) * P(H) / P(E) for each piece of evidence.",
    parameters: BayesianParams,
    async execute(_id: string, params: Static<typeof BayesianParams>) {
      let posterior = params.prior;
      const steps: string[] = [];

      for (const ev of params.evidence) {
        const newPosterior = (ev.likelihood * posterior) / ev.marginal;
        steps.push(
          `- Evidence: ${ev.description}\n  P(E|H)=${ev.likelihood}, P(E)=${ev.marginal}\n  P(H|E) = ${ev.likelihood} \u00d7 ${posterior.toFixed(4)} / ${ev.marginal} = ${newPosterior.toFixed(4)}`,
        );
        posterior = newPosterior;
      }

      const interpretation =
        posterior > 0.8
          ? "Strong support"
          : posterior > 0.5
            ? "Moderate support"
            : posterior > 0.2
              ? "Weak support"
              : "Against hypothesis";

      return textResult(`## Bayesian Update \u2014 ${params.agent_id}

**Hypothesis:** ${params.hypothesis}
**Prior:** P(H) = ${params.prior}

**Updates:**
${steps.join("\n\n")}

**Posterior:** P(H|all evidence) = ${posterior.toFixed(4)}

**Interpretation:** ${interpretation}`);
    },
  };
}
