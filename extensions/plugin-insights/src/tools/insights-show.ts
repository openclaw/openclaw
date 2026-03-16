import type Database from "better-sqlite3";
import type { PluginInsightsConfig, AgentTool } from "../types.js";
import { textToolResult } from "../types.js";
import { buildReport } from "../engine.js";
import { formatCLIReport, formatPluginSummary } from "../report/cli-report.js";
import type { ToolDetector } from "../collector/tool-detector.js";

export function createInsightsShowTool(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): AgentTool {
  return {
    name: "insights_show",
    label: "Plugin Insights Report",
    description:
      "Show the effectiveness report of installed plugins. " +
      "Displays trigger frequency, token overhead, user satisfaction, " +
      "and overall verdict for each plugin. " +
      "Use plugin parameter to see a specific plugin's detailed report.",
    parameters: {
      type: "object",
      properties: {
        plugin: {
          type: "string",
          description:
            "Optional plugin ID to show detailed report for a specific plugin",
        },
        days: {
          type: "number",
          description: "Number of days to analyze (default: 30)",
        },
      },
    },
    async execute(_toolCallId, params) {
      const days = (params.days as number) ?? 30;
      const pluginId = params.plugin as string | undefined;

      const report = buildReport(db, config, days);

      if (report.plugins.length === 0) {
        return textToolResult(buildEmptyReportMessage(db, toolDetector));
      }

      if (pluginId) {
        const plugin = report.plugins.find((p) => p.pluginId === pluginId);
        if (!plugin) {
          return textToolResult(`No data found for plugin "${pluginId}". Available plugins: ${report.plugins.map((p) => p.pluginId).join(", ")}`);
        }
        return textToolResult(formatPluginSummary(plugin));
      }

      let text = formatCLIReport(report);
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return textToolResult(text);
    },
  };
}

/** Build an informative message when no plugin attribution data exists */
function buildEmptyReportMessage(db: Database.Database, toolDetector: ToolDetector): string {
  const lines: string[] = ["No plugin attribution data yet."];

  // How many turns were collected?
  const turnCount = (db.prepare("SELECT COUNT(*) as cnt FROM turns").get() as { cnt: number }).cnt;
  if (turnCount > 0) {
    lines.push(`\n${turnCount} conversation turn(s) have been recorded.`);
  }

  // Are there unmapped tools observed at runtime? Show with counts for prioritization.
  const unmappedWithCounts = toolDetector.getUnmappedToolsWithCounts();
  if (unmappedWithCounts.length > 0) {
    lines.push(
      `\n${unmappedWithCounts.length} plugin tool(s) observed but not mapped to a plugin:`
    );
    for (const { toolName, count } of unmappedWithCounts) {
      lines.push(`  - ${toolName} (seen ${count} time${count === 1 ? "" : "s"})`);
    }
    lines.push(
      `\nTo start tracking, add toolMappings to your plugin-insights config:`,
      `  "toolMappings": [`,
      ...unmappedWithCounts.map(
        ({ toolName }) => `    { "toolName": "${toolName}", "pluginId": "<plugin-id>", "pluginName": "<Plugin Name>" },`
      ),
      `  ]`
    );
  } else if (turnCount === 0) {
    lines.push("\nKeep using OpenClaw and check back later.");
  } else {
    lines.push(
      "\nTurns were recorded but no plugin tools were observed.",
      "If you have plugins installed, make sure they are being used in conversations.",
      "Context injection markers (e.g., [memory-core]) are also detected automatically."
    );
  }

  return lines.join("\n");
}
