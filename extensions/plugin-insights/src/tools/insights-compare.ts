import type Database from "better-sqlite3";
import type { PluginInsightsConfig, PluginReport, AgentTool } from "../types.js";
import { textToolResult } from "../types.js";
import { buildReport } from "../engine.js";
import type { ToolDetector } from "../collector/tool-detector.js";

export function createInsightsCompareTool(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): AgentTool {
  return {
    name: "insights_compare",
    label: "Compare Plugin Insights",
    description:
      "Compare the effectiveness of two plugins side by side. " +
      "Shows trigger frequency, token overhead, user satisfaction, " +
      "and overall verdict for each plugin.",
    parameters: {
      type: "object",
      properties: {
        pluginA: {
          type: "string",
          description: "First plugin ID to compare",
        },
        pluginB: {
          type: "string",
          description: "Second plugin ID to compare",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
      },
      required: ["pluginA", "pluginB"],
    },
    async execute(_toolCallId, params) {
      const pluginA = params.pluginA as string;
      const pluginB = params.pluginB as string;
      const days = (params.days as number) ?? 30;

      const report = buildReport(db, config, days);

      const a = report.plugins.find((p) => p.pluginId === pluginA);
      const b = report.plugins.find((p) => p.pluginId === pluginB);

      if (!a && !b) {
        return textToolResult(`No data found for either "${pluginA}" or "${pluginB}".`);
      }
      if (!a) {
        return textToolResult(`No data found for plugin "${pluginA}".`);
      }
      if (!b) {
        return textToolResult(`No data found for plugin "${pluginB}".`);
      }

      let text = formatComparison(a, b);
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return textToolResult(text);
    },
  };
}

export function formatComparison(a: PluginReport, b: PluginReport): string {
  const nameA = a.pluginName ?? a.pluginId;
  const nameB = b.pluginName ?? b.pluginId;

  const rows: [string, string, string][] = [
    ["Metric", nameA, nameB],
    ["─".repeat(20), "─".repeat(15), "─".repeat(15)],
    ["Installed", `${a.installedDays}d`, `${b.installedDays}d`],
    [
      "Total triggers",
      `${a.triggerFrequency.totalTriggers}`,
      `${b.triggerFrequency.totalTriggers}`,
    ],
    [
      "Triggers/day",
      `${a.triggerFrequency.triggersPerDay}`,
      `${b.triggerFrequency.triggersPerDay}`,
    ],
    [
      "Token overhead",
      `${a.tokenDelta.deltaPercent >= 0 ? "+" : ""}${a.tokenDelta.deltaPercent}%`,
      `${b.tokenDelta.deltaPercent >= 0 ? "+" : ""}${b.tokenDelta.deltaPercent}%`,
    ],
    [
      "Est. cost/mo",
      `$${a.tokenDelta.estimatedMonthlyCostUSD}`,
      `$${b.tokenDelta.estimatedMonthlyCostUSD}`,
    ],
    [
      "Acceptance rate",
      `${a.implicitSatisfaction.acceptanceRate}%`,
      `${b.implicitSatisfaction.acceptanceRate}%`,
    ],
    [
      "Retry rate",
      `${a.implicitSatisfaction.retryRate}%`,
      `${b.implicitSatisfaction.retryRate}%`,
    ],
    ["Verdict", a.verdict.label, b.verdict.label],
  ];

  if (
    (a.llmJudge && a.llmJudge.sampleCount > 0) ||
    (b.llmJudge && b.llmJudge.sampleCount > 0)
  ) {
    rows.splice(-1, 0, [
      "LLM Judge",
      a.llmJudge ? `${a.llmJudge.avgScoreWithPlugin}/5` : "N/A",
      b.llmJudge ? `${b.llmJudge.avgScoreWithPlugin}/5` : "N/A",
    ]);
  }

  const col0 = Math.max(...rows.map((r) => r[0].length));
  const col1 = Math.max(...rows.map((r) => r[1].length));
  const col2 = Math.max(...rows.map((r) => r[2].length));

  return rows
    .map(
      ([c0, c1, c2]) =>
        `${c0.padEnd(col0)}  ${c1.padEnd(col1)}  ${c2.padEnd(col2)}`
    )
    .join("\n");
}
