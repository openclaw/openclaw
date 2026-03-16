import type Database from "better-sqlite3";
import type {
  OpenClawPluginCommandDefinition,
  PluginInsightsConfig,
  PluginCommandContext,
  ReplyPayload,
} from "./types.js";
import { buildReport } from "./engine.js";
import { formatCLIReport, formatPluginSummary } from "./report/cli-report.js";
import { generateHTMLReport } from "./report/html-report.js";
import { exportJSON, exportRawData } from "./report/json-export.js";
import { formatComparison } from "./tools/insights-compare.js";
import type { ToolDetector } from "./collector/tool-detector.js";
import * as fs from "node:fs";

/** Parse raw args string into positional args and flags */
function parseArgs(raw?: string): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  if (!raw) return { positional, flags };

  const parts = raw.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("--")) {
      const key = part.slice(2);
      const next = parts[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(part);
    }
  }
  return { positional, flags };
}

export function createCommands(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition[] {
  return [
    createShowCommand(db, config, toolDetector),
    createCompareCommand(db, config, toolDetector),
    createExportCommand(db, config, toolDetector),
    createDashboardCommand(db, config, toolDetector),
    createResetCommand(db),
    createStatusCommand(db, toolDetector),
  ];
}

function createShowCommand(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-show",
    description: "Show effectiveness report for installed plugins",
    acceptsArgs: true,
    handler(ctx: PluginCommandContext): ReplyPayload {
      const { positional, flags } = parseArgs(ctx.args);
      const days = Number(flags.days ?? 30);
      const pluginId = (flags.plugin as string) || positional[0];

      const report = buildReport(db, config, days);

      if (report.plugins.length === 0) {
        return { text: "No plugin activity data collected yet. Use /insights-status to see collection diagnostics." };
      }

      if (pluginId) {
        const plugin = report.plugins.find((p) => p.pluginId === pluginId);
        if (!plugin) {
          return { text: `No data found for plugin "${pluginId}". Available: ${report.plugins.map((p) => p.pluginId).join(", ")}` };
        }
        return { text: formatPluginSummary(plugin) };
      }

      let text = formatCLIReport(report);
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return { text };
    },
  };
}

function createCompareCommand(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-compare",
    description: "Compare effectiveness of two plugins side by side",
    acceptsArgs: true,
    handler(ctx: PluginCommandContext): ReplyPayload {
      const { positional, flags } = parseArgs(ctx.args);

      if (positional.length < 2) {
        return { text: "Usage: /insights-compare <pluginA> <pluginB> [--days 30]" };
      }

      const [pluginA, pluginB] = positional;
      const days = Number(flags.days ?? 30);
      const report = buildReport(db, config, days);

      const a = report.plugins.find((p) => p.pluginId === pluginA);
      const b = report.plugins.find((p) => p.pluginId === pluginB);

      if (!a) {
        return { text: `No data found for plugin "${pluginA}".` };
      }
      if (!b) {
        return { text: `No data found for plugin "${pluginB}".` };
      }

      let text = formatComparison(a, b);
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return { text };
    },
  };
}

function createExportCommand(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-export",
    description: "Export insights data as JSON",
    acceptsArgs: true,
    handler(ctx: PluginCommandContext): ReplyPayload {
      const { flags } = parseArgs(ctx.args);
      const output = flags.output as string;
      if (!output || output === "true") {
        return { text: "Usage: /insights-export --output <path> [--format json|jsonl] [--raw]" };
      }
      const format = (flags.format as "json" | "jsonl") ?? "json";
      const days = Number(flags.days ?? 30);
      const raw = !!flags.raw;

      if (raw) {
        exportRawData(db, { format, output, days });
      } else {
        const report = buildReport(db, config, days);
        // Embed coverage metadata so the JSON file is self-describing
        const unmapped = toolDetector.getUnmappedToolsWithCounts();
        report.coverage = {
          isComplete: unmapped.length === 0,
          unmappedTools: unmapped.map((t) => ({ toolName: t.toolName, callCount: t.count })),
        };
        exportJSON(report, { format, output });
      }

      let text = `Data exported to ${output}`;
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return { text };
    },
  };
}

function createDashboardCommand(
  db: Database.Database,
  config: PluginInsightsConfig,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-dashboard",
    description: "Generate an HTML dashboard report",
    acceptsArgs: true,
    handler(ctx: PluginCommandContext): ReplyPayload {
      const { flags } = parseArgs(ctx.args);
      const output =
        (flags.output as string) || "./plugin-insights-dashboard.html";
      const days = Number(flags.days ?? 30);

      const report = buildReport(db, config, days);
      const unmappedTools = toolDetector.getUnmappedToolsWithCounts();
      const html = generateHTMLReport(report, unmappedTools);

      fs.writeFileSync(output, html, "utf-8");

      let text = `Dashboard generated at ${output}`;
      const coverageNote = toolDetector.formatCoverageNote();
      if (coverageNote) {
        text += "\n" + coverageNote;
      }
      return { text };
    },
  };
}

function createResetCommand(
  db: Database.Database
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-reset",
    description: "Delete all collected insights data",
    acceptsArgs: true,
    handler(ctx: PluginCommandContext): ReplyPayload {
      const { flags } = parseArgs(ctx.args);
      if (!flags.confirm) {
        return { text: "This will permanently delete all collected data.\nRun with --confirm to proceed." };
      }

      db.transaction(() => {
        db.exec("DELETE FROM satisfaction_signals");
        db.exec("DELETE FROM llm_scores");
        db.exec("DELETE FROM plugin_events");
        db.exec("DELETE FROM turns");
        db.exec("DELETE FROM plugin_installs");
        db.exec("DELETE FROM observed_unmapped_tools");
      })();

      return { text: "All insights data has been reset." };
    },
  };
}

function createStatusCommand(
  db: Database.Database,
  toolDetector: ToolDetector
): OpenClawPluginCommandDefinition {
  return {
    name: "insights-status",
    description: "Show data collection diagnostics and attribution status",
    handler(): ReplyPayload {
      const lines: string[] = ["Plugin Insights — Collection Status", "═".repeat(40)];

      // Turn stats
      const turnCount = (db.prepare("SELECT COUNT(*) as cnt FROM turns").get() as { cnt: number }).cnt;
      const sessionCount = (db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM turns").get() as { cnt: number }).cnt;
      lines.push(`\nTurns collected: ${turnCount}`);
      lines.push(`Sessions tracked: ${sessionCount}`);

      // Plugin event stats
      const eventCount = (db.prepare("SELECT COUNT(*) as cnt FROM plugin_events").get() as { cnt: number }).cnt;
      lines.push(`Plugin events recorded: ${eventCount}`);

      // Mapped plugins (from tool_plugin_mapping)
      const mappedRows = db.prepare("SELECT DISTINCT plugin_id, plugin_name FROM tool_plugin_mapping").all() as { plugin_id: string; plugin_name: string | null }[];
      if (mappedRows.length > 0) {
        lines.push(`\nConfigured tool→plugin mappings (${mappedRows.length} plugin(s)):`);
        for (const row of mappedRows) {
          const name = row.plugin_name ? ` (${row.plugin_name})` : "";
          const tools = (db.prepare("SELECT tool_name FROM tool_plugin_mapping WHERE plugin_id = ?").all(row.plugin_id) as { tool_name: string }[])
            .map((r) => r.tool_name);
          lines.push(`  ${row.plugin_id}${name}: ${tools.join(", ")}`);
        }
      } else {
        lines.push("\nNo tool→plugin mappings configured.");
      }

      // Unmapped tools (with observation counts, from DB)
      const unmappedWithCounts = toolDetector.getUnmappedToolsWithCounts();
      if (unmappedWithCounts.length > 0) {
        lines.push(`\nUnmapped tools observed at runtime (${unmappedWithCounts.length}):`);
        for (const { toolName, count } of unmappedWithCounts) {
          lines.push(`  - ${toolName} (seen ${count} time${count === 1 ? "" : "s"})`);
        }
        lines.push(`\nAdd these to your config to start tracking:`);
        lines.push(`  "toolMappings": [`);
        for (const { toolName } of unmappedWithCounts) {
          lines.push(`    { "toolName": "${toolName}", "pluginId": "<plugin-id>" },`);
        }
        lines.push(`  ]`);
      } else if (turnCount > 0 && mappedRows.length === 0) {
        lines.push(
          "\nNo plugin tools observed yet.",
          "Keep using plugins in conversations — tool names will appear here."
        );
      }

      // Context detections
      const contextCount = (db.prepare("SELECT COUNT(*) as cnt FROM plugin_events WHERE detection_method = 'context_injection'").get() as { cnt: number }).cnt;
      if (contextCount > 0) {
        lines.push(`\nContext injection detections: ${contextCount}`);
      }

      return { text: lines.join("\n") };
    },
  };
}
