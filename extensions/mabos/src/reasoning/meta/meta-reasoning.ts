/**
 * Meta-Reasoning Tool — classifies problems and selects optimal reasoning methods.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";
import { REASONING_METHODS } from "../methods.js";
import type { ProblemClassification, MethodRecommendation } from "../types.js";

const ProblemClassificationSchema = Type.Object({
  uncertainty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  complexity: Type.Union([
    Type.Literal("simple"),
    Type.Literal("moderate"),
    Type.Literal("complex"),
  ]),
  domain: Type.Union([
    Type.Literal("formal"),
    Type.Literal("empirical"),
    Type.Literal("social"),
    Type.Literal("mixed"),
  ]),
  time_pressure: Type.Union([
    Type.Literal("none"),
    Type.Literal("moderate"),
    Type.Literal("urgent"),
  ]),
  data_availability: Type.Union([
    Type.Literal("rich"),
    Type.Literal("moderate"),
    Type.Literal("sparse"),
  ]),
  stakes: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

const MetaReasoningParams = Type.Object({
  problem: Type.String({ description: "Problem statement to classify" }),
  problem_classification: Type.Optional(ProblemClassificationSchema),
  available_methods: Type.Optional(
    Type.Array(Type.String(), { description: "Subset of methods to consider" }),
  ),
});

/**
 * Selection matrix: maps problem dimensions to method category weights.
 * Each dimension value adds weight to specific categories.
 */
const SELECTION_MATRIX: Record<string, Record<string, Record<string, number>>> = {
  uncertainty: {
    low: { formal: 0.3, probabilistic: 0.0, causal: 0.1, experience: 0.1, social: 0.0, meta: 0.0 },
    medium: {
      formal: 0.1,
      probabilistic: 0.2,
      causal: 0.2,
      experience: 0.1,
      social: 0.1,
      meta: 0.1,
    },
    high: { formal: 0.0, probabilistic: 0.3, causal: 0.1, experience: 0.2, social: 0.1, meta: 0.1 },
  },
  complexity: {
    simple: {
      formal: 0.2,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.2,
      social: 0.0,
      meta: 0.0,
    },
    moderate: {
      formal: 0.1,
      probabilistic: 0.1,
      causal: 0.2,
      experience: 0.1,
      social: 0.1,
      meta: 0.1,
    },
    complex: {
      formal: 0.1,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.1,
      social: 0.1,
      meta: 0.3,
    },
  },
  domain: {
    formal: {
      formal: 0.4,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.0,
      social: 0.0,
      meta: 0.0,
    },
    empirical: {
      formal: 0.1,
      probabilistic: 0.3,
      causal: 0.2,
      experience: 0.1,
      social: 0.0,
      meta: 0.0,
    },
    social: {
      formal: 0.0,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.1,
      social: 0.3,
      meta: 0.1,
    },
    mixed: {
      formal: 0.1,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.1,
      social: 0.1,
      meta: 0.2,
    },
  },
  time_pressure: {
    none: { formal: 0.2, probabilistic: 0.1, causal: 0.2, experience: 0.1, social: 0.1, meta: 0.1 },
    moderate: {
      formal: 0.1,
      probabilistic: 0.1,
      causal: 0.1,
      experience: 0.2,
      social: 0.1,
      meta: 0.1,
    },
    urgent: {
      formal: 0.0,
      probabilistic: 0.1,
      causal: 0.0,
      experience: 0.3,
      social: 0.1,
      meta: 0.0,
    },
  },
  data_availability: {
    rich: { formal: 0.1, probabilistic: 0.3, causal: 0.2, experience: 0.0, social: 0.0, meta: 0.0 },
    moderate: {
      formal: 0.1,
      probabilistic: 0.2,
      causal: 0.1,
      experience: 0.1,
      social: 0.1,
      meta: 0.1,
    },
    sparse: {
      formal: 0.2,
      probabilistic: 0.0,
      causal: 0.1,
      experience: 0.2,
      social: 0.1,
      meta: 0.1,
    },
  },
  stakes: {
    low: { formal: 0.1, probabilistic: 0.1, causal: 0.1, experience: 0.2, social: 0.0, meta: 0.0 },
    medium: {
      formal: 0.1,
      probabilistic: 0.1,
      causal: 0.2,
      experience: 0.1,
      social: 0.1,
      meta: 0.1,
    },
    high: { formal: 0.2, probabilistic: 0.1, causal: 0.1, experience: 0.0, social: 0.2, meta: 0.2 },
  },
};

/**
 * Score methods against a problem classification using the selection matrix.
 */
export function scoreMethodsForProblem(
  classification: ProblemClassification,
  availableMethods?: string[],
): MethodRecommendation[] {
  // Accumulate category weights from selection matrix
  const categoryWeights: Record<string, number> = {
    formal: 0,
    probabilistic: 0,
    causal: 0,
    experience: 0,
    social: 0,
    meta: 0,
  };

  for (const [dimension, value] of Object.entries(classification)) {
    const weights = SELECTION_MATRIX[dimension]?.[value];
    if (weights) {
      for (const [cat, w] of Object.entries(weights)) {
        categoryWeights[cat] = (categoryWeights[cat] || 0) + w;
      }
    }
  }

  // Normalize category weights
  const totalWeight = Object.values(categoryWeights).reduce((a, b) => a + b, 0);
  if (totalWeight > 0) {
    for (const cat of Object.keys(categoryWeights)) {
      categoryWeights[cat] /= totalWeight;
    }
  }

  // Score each method based on its category weight
  const methods = availableMethods || Object.keys(REASONING_METHODS);
  const recommendations: MethodRecommendation[] = [];

  for (const methodName of methods) {
    const method = REASONING_METHODS[methodName];
    if (!method) continue;

    const categoryScore = categoryWeights[method.category] || 0;
    // Boost methods with dedicated tools slightly (they're more refined)
    const toolBoost = method.dedicated_tool ? 0.05 : 0;
    const score = Math.min(1, categoryScore + toolBoost);

    recommendations.push({
      method: methodName,
      score,
      rationale: `Category ${method.category} scored ${(categoryScore * 100).toFixed(0)}% for this problem profile. ${method.applicable_when}`,
    });
  }

  // Sort by score descending
  recommendations.sort((a, b) => b.score - a.score);
  return recommendations;
}

export function createMetaReasoningTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_meta",
    label: "Meta-Reasoning",
    description:
      "Classify a problem and recommend the best reasoning method(s). Uses a selection matrix across 6 problem dimensions.",
    parameters: MetaReasoningParams,
    async execute(_id: string, params: Static<typeof MetaReasoningParams>) {
      const classification = params.problem_classification || {
        uncertainty: "medium" as const,
        complexity: "moderate" as const,
        domain: "mixed" as const,
        time_pressure: "none" as const,
        data_availability: "moderate" as const,
        stakes: "medium" as const,
      };

      const recommendations = scoreMethodsForProblem(classification, params.available_methods);
      const top5 = recommendations.slice(0, 5);
      const topMethod = recommendations[0];

      const classStr = Object.entries(classification)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");

      const recStr = top5
        .map(
          (r, i) =>
            `${i + 1}. **${r.method}** (score: ${(r.score * 100).toFixed(0)}%)\n   ${r.rationale}`,
        )
        .join("\n\n");

      return textResult(`## Meta-Reasoning Analysis

**Problem:** ${params.problem}

**Classification:**
${classStr}

**Top Recommended Methods:**

${recStr}

**Primary Recommendation:** Use **${topMethod.method}** (${REASONING_METHODS[topMethod.method]?.description}).

${params.problem_classification ? "" : "Note: No explicit classification was provided — using default (medium) profile. Provide `problem_classification` for more targeted recommendations."}

To apply the recommended method, use \`reason\` with \`method: "${topMethod.method}"\` or use the dedicated tool \`${REASONING_METHODS[topMethod.method]?.dedicated_tool || "reason"}\`.`);
    },
  };
}
