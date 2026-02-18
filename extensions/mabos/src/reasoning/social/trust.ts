/**
 * Trust Reasoning Tool
 *
 * Computes a quantitative trust score for an agent based on interaction
 * history using exponential time-decay weighting and sigmoid normalization.
 *
 * Purely algorithmic — no LLM interpretation needed.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const TrustParams = Type.Object({
  target_agent_id: Type.String({
    description: "Identifier of the agent whose trustworthiness is being evaluated",
  }),
  history: Type.Array(
    Type.Object({
      outcome: Type.Union(
        [Type.Literal("success"), Type.Literal("failure"), Type.Literal("partial")],
        { description: "Outcome of the interaction" },
      ),
      value: Type.Number({
        description: "Magnitude / importance of the interaction (positive number)",
      }),
      timestamp: Type.String({
        description: "ISO-8601 timestamp of the interaction",
      }),
    }),
    { description: "Chronological history of interactions with this agent" },
  ),
  decay_factor: Type.Optional(
    Type.Number({
      description:
        "Exponential decay factor per day (default 0.95). Controls how quickly older interactions lose influence.",
      default: 0.95,
    }),
  ),
});

export function createTrustTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_trust",
    label: "Trust Reasoning",
    description:
      "Compute a quantitative trust score for an agent based on interaction history. Uses exponential time-decay weighting, sigmoid normalization, and derives reliability, consistency, and recency trend metrics.",
    parameters: TrustParams,
    async execute(_id: string, params: Static<typeof TrustParams>) {
      const decay = params.decay_factor ?? 0.95;
      const now = Date.now();

      if (params.history.length === 0) {
        return textResult(`## Trust Assessment — ${params.target_agent_id}

**No interaction history available.**

Trust score defaults to 0.5 (neutral/unknown).
Reliability, consistency, and recency trend cannot be computed without data.`);
      }

      // --- Compute per-interaction values ---
      const entries = params.history.map((h) => {
        const ts = new Date(h.timestamp).getTime();
        const ageDays = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
        const weight = Math.pow(decay, ageDays);

        let outcomeValue: number;
        if (h.outcome === "success") {
          outcomeValue = h.value;
        } else if (h.outcome === "partial") {
          outcomeValue = h.value * 0.5;
        } else {
          outcomeValue = -h.value;
        }

        return { ...h, ageDays, weight, outcomeValue };
      });

      // --- Raw score (weighted mean) ---
      const weightedSum = entries.reduce((acc, e) => acc + e.outcomeValue * e.weight, 0);
      const totalWeight = entries.reduce((acc, e) => acc + e.weight, 0);
      const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      // --- Sigmoid normalization to [0, 1] ---
      const trustScore = 1 / (1 + Math.exp(-rawScore));

      // --- Reliability: fraction of successful interactions ---
      const successCount = entries.filter((e) => e.outcome === "success").length;
      const reliability = successCount / entries.length;

      // --- Consistency: 1 - normalized standard deviation ---
      const outcomeValues = entries.map((e) => e.outcomeValue);
      const mean = outcomeValues.reduce((a, b) => a + b, 0) / outcomeValues.length;
      const variance =
        outcomeValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / outcomeValues.length;
      const stddev = Math.sqrt(variance);
      const minVal = Math.min(...outcomeValues);
      const maxVal = Math.max(...outcomeValues);
      const range = maxVal - minVal;
      const consistency = 1 - stddev / Math.max(range, 1);

      // --- Recency trend: compare last 3 vs overall ---
      const sorted = [...entries].sort((a, b) => a.ageDays - b.ageDays); // most recent first
      const recentSlice = sorted.slice(0, Math.min(3, sorted.length));
      const recentMean = recentSlice.reduce((a, e) => a + e.outcomeValue, 0) / recentSlice.length;
      const overallMean = mean;
      const recencyTrend = recentMean - overallMean;

      const trendLabel =
        recencyTrend > 0.1 ? "Improving" : recencyTrend < -0.1 ? "Declining" : "Stable";

      // --- Interpretation ---
      let interpretation: string;
      if (trustScore >= 0.8) {
        interpretation = "High trust — consistently reliable partner.";
      } else if (trustScore >= 0.6) {
        interpretation = "Moderate trust — generally dependable with some variability.";
      } else if (trustScore >= 0.4) {
        interpretation = "Neutral trust — insufficient evidence for strong confidence either way.";
      } else if (trustScore >= 0.2) {
        interpretation = "Low trust — history suggests unreliability or negative outcomes.";
      } else {
        interpretation = "Very low trust — strong pattern of failure or adverse interactions.";
      }

      // --- Build step-by-step trace ---
      const stepLines = entries.map(
        (e) =>
          `  - ${e.timestamp} | ${e.outcome} | value=${e.value} | outcome_value=${e.outcomeValue.toFixed(2)} | age=${e.ageDays.toFixed(1)}d | weight=${e.weight.toFixed(4)}`,
      );

      return textResult(`## Trust Assessment — ${params.target_agent_id}

**Decay Factor:** ${decay} per day
**Interactions Analyzed:** ${entries.length}

**Step-by-step breakdown:**
${stepLines.join("\n")}

**Weighted raw score:** ${rawScore.toFixed(4)}
  (sum of outcome_value * weight) / (sum of weights) = ${weightedSum.toFixed(4)} / ${totalWeight.toFixed(4)}

**Results:**
| Metric          | Value                          |
|-----------------|--------------------------------|
| Trust Score     | ${trustScore.toFixed(4)} (sigmoid of ${rawScore.toFixed(4)}) |
| Reliability     | ${reliability.toFixed(4)} (${successCount}/${entries.length} successful) |
| Consistency     | ${consistency.toFixed(4)} (1 - stddev/range = 1 - ${stddev.toFixed(4)}/${Math.max(range, 1).toFixed(4)}) |
| Recency Trend   | ${recencyTrend.toFixed(4)} — ${trendLabel} |

**Interpretation:** ${interpretation}`);
    },
  };
}
