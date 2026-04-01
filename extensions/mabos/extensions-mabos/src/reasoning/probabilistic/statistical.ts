/**
 * Statistical Reasoning Tool (Hybrid)
 *
 * Computes descriptive statistics algorithmically (mean, median, stddev,
 * min, max, count) then formats the results with context into a prompt
 * for LLM-based interpretation.
 *
 * Supports three analysis types:
 *   - descriptive: summarize a single dataset
 *   - comparative: compare subgroups within the data
 *   - trend: identify directional patterns over ordered data
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const StatisticalParams = Type.Object({
  data: Type.Array(
    Type.Object({
      label: Type.String(),
      value: Type.Number(),
    }),
    { description: "Data points with labels and numeric values" },
  ),
  analysis_type: Type.Union(
    [Type.Literal("descriptive"), Type.Literal("comparative"), Type.Literal("trend")],
    { description: "Type of statistical analysis to perform" },
  ),
  context: Type.Optional(
    Type.String({ description: "Business or domain context for interpretation" }),
  ),
});

/** Compute core descriptive statistics for an array of numbers. */
function computeStats(values: number[]) {
  const n = values.length;
  if (n === 0) {
    return { count: 0, mean: 0, median: 0, stddev: 0, min: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / n;

  const median = n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  return {
    count: n,
    mean: parseFloat(mean.toFixed(4)),
    median: parseFloat(median.toFixed(4)),
    stddev: parseFloat(stddev.toFixed(4)),
    min: sorted[0],
    max: sorted[n - 1],
  };
}

export function createStatisticalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_statistical",
    label: "Statistical Reasoning",
    description:
      "Compute descriptive statistics (mean, median, stddev, min, max) from data and produce an LLM interpretation prompt. Supports descriptive, comparative, and trend analysis.",
    parameters: StatisticalParams,
    async execute(_id: string, params: Static<typeof StatisticalParams>) {
      const values = params.data.map((d) => d.value);
      const stats = computeStats(values);

      // Format the data table
      const dataTable = params.data.map((d) => `| ${d.label} | ${d.value} |`).join("\n");

      // Build analysis-type-specific instructions
      let analysisInstructions: string;

      switch (params.analysis_type) {
        case "descriptive":
          analysisInstructions = `**Analysis Type:** Descriptive

Provide a comprehensive summary of the dataset:
1. Characterize the central tendency (mean vs median — is the data skewed?).
2. Assess the spread (stddev relative to mean — is there high variability?).
3. Note the range (min to max) and any potential outliers.
4. Summarize what the data tells us in plain language.`;
          break;

        case "comparative":
          analysisInstructions = `**Analysis Type:** Comparative

Compare the data points against each other:
1. Which items are above/below the mean?
2. Identify the top and bottom performers by label.
3. How much variation exists between items (stddev as % of mean)?
4. Are there distinct clusters or groupings?
5. What comparative insights can be drawn?`;
          break;

        case "trend":
          analysisInstructions = `**Analysis Type:** Trend

Analyze the data for directional patterns (data is in order):
1. Is there an upward, downward, or flat trend?
2. Identify any inflection points or sudden changes.
3. Compare the first half vs second half averages.
4. What is the rate of change (first vs last value)?
5. Project the likely next value if the trend continues.`;
          break;
      }

      return textResult(`## Statistical Analysis

**Computed Statistics:**
| Metric | Value |
|--------|-------|
| Count | ${stats.count} |
| Mean | ${stats.mean} |
| Median | ${stats.median} |
| Std Dev | ${stats.stddev} |
| Min | ${stats.min} |
| Max | ${stats.max} |

**Raw Data:**
| Label | Value |
|-------|-------|
${dataTable}

${analysisInstructions}

${params.context ? `**Context:** ${params.context}\n\nInterpret the statistics above in light of this context.` : ""}

Provide your interpretation with confidence level (high/medium/low) and any caveats.`);
    },
  };
}
