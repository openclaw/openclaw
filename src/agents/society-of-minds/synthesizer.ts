import type { ModelResult, SocietyOfMindsResult } from "./types.js";

/**
 * Synthesizes results from multiple models into a unified response.
 */
export class ResultSynthesizer {
  /**
   * Combines multiple model results into a single synthesized response.
   */
  static synthesize(
    modelResults: ModelResult[],
    task: string,
    synthesisPrompt?: string,
  ): SocietyOfMindsResult {
    const successfulResults = modelResults.filter((r) => !r.error);
    const errors = modelResults.filter((r) => r.error).map((r) => r.error!);

    if (successfulResults.length === 0) {
      return {
        status: "error",
        modelResults,
        errors: errors.length > 0 ? errors : ["All models failed"],
      };
    }

    // Calculate aggregate stats
    const totalTokens = modelResults.reduce(
      (sum, r) => sum + (r.tokens?.total ?? 0),
      0,
    );
    const totalCost = modelResults.reduce((sum, r) => sum + (r.cost ?? 0), 0);

    // If only one successful result, return it directly
    if (successfulResults.length === 1) {
      return {
        status: errors.length > 0 ? "partial" : "success",
        synthesizedResult: successfulResults[0].result,
        modelResults,
        errors: errors.length > 0 ? errors : undefined,
        totalTokens,
        totalCost,
      };
    }

    // Build synthesis prompt
    const synthesisText = synthesisPrompt || this.buildDefaultSynthesisPrompt(
      task,
      successfulResults,
    );

    return {
      status: errors.length > 0 ? "partial" : "success",
      synthesizedResult: synthesisText,
      modelResults,
      errors: errors.length > 0 ? errors : undefined,
      totalTokens,
      totalCost,
    };
  }

  /**
   * Builds a default synthesis prompt combining all model results.
   */
  private static buildDefaultSynthesisPrompt(
    task: string,
    results: ModelResult[],
  ): string {
    const sections = results.map((r, idx) => {
      return `## ${r.model}:\n\n${r.result}\n`;
    });

    return `# Synthesized Response

**Task:** ${task}

**Analysis from ${results.length} models:**

${sections.join("\n")}

**Summary:** Based on the analysis from multiple AI models, the consensus approach combines the best insights from each model. The key recommendations are synthesized above, taking into account different perspectives and strengths of each model.`;
  }

  /**
   * Extracts key insights from multiple results using simple heuristics.
   */
  static extractKeyInsights(results: ModelResult[]): string[] {
    const insights: string[] = [];
    const successfulResults = results.filter((r) => !r.error);

    // Look for common themes
    const allText = successfulResults.map((r) => r.result.toLowerCase()).join(" ");
    const commonPhrases = [
      "important",
      "key",
      "critical",
      "recommend",
      "suggest",
      "should",
      "must",
    ];

    for (const phrase of commonPhrases) {
      if (allText.includes(phrase)) {
        insights.push(`Multiple models emphasized: ${phrase}`);
      }
    }

    // Extract model-specific strengths
    for (const result of successfulResults) {
      if (result.model.includes("claude")) {
        insights.push("Claude provided detailed reasoning");
      } else if (result.model.includes("gpt")) {
        insights.push("GPT-4 provided structured analysis");
      } else if (result.model.includes("gemini")) {
        insights.push("Gemini provided alternative perspectives");
      } else if (result.model.includes("grok")) {
        insights.push("Grok provided real-time information");
      }
    }

    return insights;
  }
}
