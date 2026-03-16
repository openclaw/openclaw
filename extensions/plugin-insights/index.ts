import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginInsightsConfig,
} from "./src/types.js";
import { resolveConfig } from "./src/db/config.js";
import { createDb } from "./src/db/connection.js";
import {
  createInsightsEngine,
  cleanupOldData,
  type ToolPluginMapping,
} from "./src/engine.js";
import { createInsightsShowTool } from "./src/tools/insights-show.js";
import { createInsightsCompareTool } from "./src/tools/insights-compare.js";
import { createCommands } from "./src/commands.js";

/**
 * Plugin Insights — OpenClaw plugin definition.
 *
 * Exported as OpenClawPluginDefinition per the real SDK contract.
 * OpenClaw will call `register(api)` on plugin load.
 */
const pluginDefinition: OpenClawPluginDefinition = {
  id: "plugin-insights",
  name: "Plugin Insights",
  description:
    "Automatically evaluate how much your installed plugins actually help",
  version: "0.1.0",

  register(api: OpenClawPluginApi): void {
    const userConfig = (api.pluginConfig ?? {}) as Partial<PluginInsightsConfig> & {
      toolMappings?: { toolName: string; pluginId: string; pluginName?: string }[];
    };
    const config = resolveConfig(userConfig);

    if (!config.enabled) return;

    const db = createDb(config.dbPath);

    // Layer 1: Seed tool→plugin mapping from user config
    const toolPluginMappings: ToolPluginMapping[] =
      userConfig.toolMappings?.map((m) => ({
        toolName: m.toolName,
        pluginId: m.pluginId,
        pluginName: m.pluginName,
      })) ?? [];

    const { engine, toolDetector } = createInsightsEngine(
      db,
      config,
      toolPluginMappings
    );

    // Register as ContextEngine (ownsCompaction: false — non-invasive)
    api.registerContextEngine("plugin-insights", () => engine);

    // Register agent tools (pass toolDetector for coverage diagnostics)
    api.registerTool(createInsightsShowTool(db, config, toolDetector));
    api.registerTool(createInsightsCompareTool(db, config, toolDetector));

    // Register slash-commands (pass toolDetector for /insights-status)
    for (const cmd of createCommands(db, config, toolDetector)) {
      api.registerCommand(cmd);
    }

    // Layer 1: Observe tool calls at runtime via after_tool_call hook.
    // Records non-builtin tool names for diagnostic purposes.
    // Only tools with explicit toolMappings config appear in reports.
    api.on("after_tool_call", (event, ctx) => {
      const toolName = event?.toolName ?? ctx?.toolName;
      if (!toolName) return;

      // Skip our own tools
      if (toolName === "insights_show" || toolName === "insights_compare") {
        return;
      }

      try {
        toolDetector.learnTool(toolName);
      } catch {
        // Best-effort
      }
    });

    // Deferred cleanup of expired data (non-blocking)
    setTimeout(() => {
      try {
        cleanupOldData(db, config.retentionDays);
      } catch {
        // Cleanup is best-effort
      }
    }, 5_000);
  },
};

export default pluginDefinition;

// Re-export types for consumers
export type { InsightsAPIReport, PluginInsightsConfig } from "./src/types.js";
export type { PluginInsightsPublicAPI } from "./src/collector/plugin-reporter.js";
