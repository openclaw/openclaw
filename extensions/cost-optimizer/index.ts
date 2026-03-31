import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolFactory } from "./runtime-api.js";
import { BudgetManager } from "./src/budget-manager.js";
import { CostTracker } from "./src/cost-tracker.js";
import { createClassifyTool, createCostReportTool, createSetBudgetTool } from "./src/cost-tools.js";

export default definePluginEntry({
  id: "cost-optimizer",
  name: "Cost Optimizer",
  description: "Predictive cost tracking, budget management, and smart model routing",
  register(api: OpenClawPluginApi) {
    const tracker = new CostTracker();

    // Read budget config from plugin config if available
    const pluginConfig = api.pluginConfig ?? {};
    const budgetManager = new BudgetManager(tracker, {
      dailyBudget: typeof pluginConfig.dailyBudget === "number" ? pluginConfig.dailyBudget : 0,
      weeklyBudget: typeof pluginConfig.weeklyBudget === "number" ? pluginConfig.weeklyBudget : 0,
      monthlyBudget:
        typeof pluginConfig.monthlyBudget === "number" ? pluginConfig.monthlyBudget : 0,
      hardCap: typeof pluginConfig.hardCap === "boolean" ? pluginConfig.hardCap : false,
      alertThresholds: Array.isArray(pluginConfig.alertThresholds)
        ? pluginConfig.alertThresholds
        : [50, 80, 100],
    });

    // Register cost_report tool (optional — requires explicit allowlist)
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createCostReportTool(tracker, budgetManager) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Register set_budget tool (optional)
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createSetBudgetTool(budgetManager) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Register classify_task tool (optional)
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createClassifyTool() as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );

    // Hook: record usage events
    api.on("llm_output", (event, ctx) => {
      if (event && event.provider && event.model && event.usage) {
        tracker.recordUsage({
          agentId: ctx?.agentId ?? "main",
          provider: event.provider,
          model: event.model,
          inputTokens: event.usage.input ?? 0,
          outputTokens: event.usage.output ?? 0,
          cacheReadTokens: event.usage.cacheRead ?? 0,
          cacheWriteTokens: event.usage.cacheWrite ?? 0,
        });
      }
    });
  },
});
