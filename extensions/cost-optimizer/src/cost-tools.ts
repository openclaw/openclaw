/**
 * Agent tools for the cost-optimizer plugin.
 *
 * Provides two tools:
 *   - cost_report: Get cost breakdown by model, agent, and time period
 *   - set_budget: Configure budget limits and alerts from chat
 */

import { Type } from "@sinclair/typebox";
import type { BudgetManager } from "./budget-manager.js";
import type { CostTracker, TimePeriod } from "./cost-tracker.js";
import type { ClassificationResult } from "./task-classifier.js";
import { classifyComplexity, suggestModelTier } from "./task-classifier.js";

function formatUSD(amount: number): string {
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

export function createCostReportTool(tracker: CostTracker, budgetManager: BudgetManager) {
  return {
    name: "cost_report",
    label: "Cost Report",
    description:
      "Get AI spending breakdown by model, agent, and time period. Shows token usage, costs, daily trends, budget status, and savings estimates.",
    parameters: Type.Object({
      period: Type.Optional(
        Type.Unsafe<TimePeriod>({
          type: "string",
          enum: ["today", "week", "month", "all"],
          description: "Time period for the report (default: today)",
        }),
      ),
      agentId: Type.Optional(
        Type.String({
          description: "Filter by agent ID (optional, shows all agents if omitted)",
        }),
      ),
      showDailyTrend: Type.Optional(
        Type.Boolean({
          description: "Include daily cost trend for the last 7 days (default: false)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const period = (typeof params.period === "string" ? params.period : "today") as TimePeriod;
      const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
      const showDailyTrend =
        typeof params.showDailyTrend === "boolean" ? params.showDailyTrend : false;

      const summary = tracker.getSummary(period, agentId);
      const budgetStatus = budgetManager.getStatus(agentId);

      const lines: string[] = [];

      // Header
      const periodLabel =
        period === "today"
          ? "Today"
          : period === "week"
            ? "This Week"
            : period === "month"
              ? "This Month"
              : "All Time";
      lines.push(`## 💰 Cost Report — ${periodLabel}`);
      if (agentId) {
        lines.push(`**Agent:** ${agentId}`);
      }
      lines.push("");

      // Summary
      lines.push(`| Metric | Value |`);
      lines.push(`| --- | --- |`);
      lines.push(`| Total Cost | **${formatUSD(summary.totalCost)}** |`);
      lines.push(`| Interactions | ${summary.eventCount} |`);
      lines.push(`| Input Tokens | ${formatTokens(summary.totalInputTokens)} |`);
      lines.push(`| Output Tokens | ${formatTokens(summary.totalOutputTokens)} |`);
      if (summary.totalCacheReadTokens > 0) {
        lines.push(`| Cache Read Tokens | ${formatTokens(summary.totalCacheReadTokens)} |`);
      }
      lines.push("");

      // Cost by Model
      if (summary.byModel.size > 0) {
        lines.push("### By Model");
        lines.push(`| Model | Cost | Interactions |`);
        lines.push(`| --- | --- | --- |`);
        const sortedModels = [...summary.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
        for (const [model, data] of sortedModels) {
          const pct =
            summary.totalCost > 0 ? ((data.cost / summary.totalCost) * 100).toFixed(0) : "0";
          lines.push(`| ${model} | ${formatUSD(data.cost)} (${pct}%) | ${data.events} |`);
        }
        lines.push("");
      }

      // Cost by Agent
      if (summary.byAgent.size > 1) {
        lines.push("### By Agent");
        lines.push(`| Agent | Cost | Interactions |`);
        lines.push(`| --- | --- | --- |`);
        const sortedAgents = [...summary.byAgent.entries()].sort((a, b) => b[1].cost - a[1].cost);
        for (const [agent, data] of sortedAgents) {
          lines.push(`| ${agent} | ${formatUSD(data.cost)} | ${data.events} |`);
        }
        lines.push("");
      }

      // Budget Status
      const budgetSections: string[] = [];
      if (!budgetStatus.daily.unlimited) {
        budgetSections.push(
          `Daily: ${formatUSD(budgetStatus.daily.spent)} / ${formatUSD(budgetStatus.daily.budget)} (${budgetStatus.daily.percentUsed.toFixed(0)}%)`,
        );
      }
      if (!budgetStatus.weekly.unlimited) {
        budgetSections.push(
          `Weekly: ${formatUSD(budgetStatus.weekly.spent)} / ${formatUSD(budgetStatus.weekly.budget)} (${budgetStatus.weekly.percentUsed.toFixed(0)}%)`,
        );
      }
      if (!budgetStatus.monthly.unlimited) {
        budgetSections.push(
          `Monthly: ${formatUSD(budgetStatus.monthly.spent)} / ${formatUSD(budgetStatus.monthly.budget)} (${budgetStatus.monthly.percentUsed.toFixed(0)}%)`,
        );
      }

      if (budgetSections.length > 0) {
        lines.push("### Budget Status");
        for (const section of budgetSections) {
          lines.push(`- ${section}`);
        }
        if (budgetStatus.blocked) {
          lines.push("");
          lines.push("⚠️ **Budget exceeded — requests are being blocked.**");
        }
        lines.push("");
      }

      // Daily trend
      if (showDailyTrend) {
        const dailyTotals = tracker.getDailyTotals(7);
        if (dailyTotals.length > 0) {
          lines.push("### Daily Trend (Last 7 Days)");
          lines.push(`| Date | Cost | Interactions |`);
          lines.push(`| --- | --- | --- |`);
          for (const day of dailyTotals) {
            lines.push(`| ${day.date} | ${formatUSD(day.cost)} | ${day.events} |`);
          }
          lines.push("");
        }
      }

      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          summary,
          budget: budgetStatus,
          period,
        },
      };
    },
  };
}

export function createSetBudgetTool(budgetManager: BudgetManager) {
  return {
    name: "set_budget",
    label: "Set Budget",
    description:
      "Configure AI spending budget limits and alerts. Set daily, weekly, or monthly caps with optional hard blocking.",
    parameters: Type.Object({
      dailyBudget: Type.Optional(
        Type.Number({ description: "Maximum daily spend in USD (0 = unlimited)" }),
      ),
      weeklyBudget: Type.Optional(
        Type.Number({ description: "Maximum weekly spend in USD (0 = unlimited)" }),
      ),
      monthlyBudget: Type.Optional(
        Type.Number({ description: "Maximum monthly spend in USD (0 = unlimited)" }),
      ),
      hardCap: Type.Optional(
        Type.Boolean({
          description: "Block requests when budget exceeded (default: false = warn only)",
        }),
      ),
      alertThresholds: Type.Optional(
        Type.Array(Type.Number(), {
          description: "Budget percentage thresholds for alerts (default: [50, 80, 100])",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const updates: Record<string, unknown> = {};

      if (typeof params.dailyBudget === "number") updates.dailyBudget = params.dailyBudget;
      if (typeof params.weeklyBudget === "number") updates.weeklyBudget = params.weeklyBudget;
      if (typeof params.monthlyBudget === "number") updates.monthlyBudget = params.monthlyBudget;
      if (typeof params.hardCap === "boolean") updates.hardCap = params.hardCap;
      if (Array.isArray(params.alertThresholds)) updates.alertThresholds = params.alertThresholds;

      budgetManager.updateConfig(updates as Parameters<typeof budgetManager.updateConfig>[0]);

      const config = budgetManager.getConfig();

      const lines: string[] = [];
      lines.push("## ✅ Budget Updated");
      lines.push("");
      lines.push(`| Setting | Value |`);
      lines.push(`| --- | --- |`);
      lines.push(
        `| Daily Budget | ${config.dailyBudget > 0 ? formatUSD(config.dailyBudget) : "Unlimited"} |`,
      );
      lines.push(
        `| Weekly Budget | ${config.weeklyBudget > 0 ? formatUSD(config.weeklyBudget) : "Unlimited"} |`,
      );
      lines.push(
        `| Monthly Budget | ${config.monthlyBudget > 0 ? formatUSD(config.monthlyBudget) : "Unlimited"} |`,
      );
      lines.push(`| Hard Cap | ${config.hardCap ? "Yes (blocks requests)" : "No (warns only)"} |`);
      lines.push(`| Alert Thresholds | ${config.alertThresholds.join("%, ")}% |`);

      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: { config },
      };
    },
  };
}

export function createClassifyTool() {
  return {
    name: "classify_task",
    label: "Classify Task Complexity",
    description:
      "Analyze a message to determine its complexity tier and suggest an optimal model routing tier (cheap, balanced, premium).",
    parameters: Type.Object({
      message: Type.String({ description: "The user message to classify" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const message = typeof params.message === "string" ? params.message : "";
      if (!message.trim()) {
        return {
          content: [{ type: "text", text: "Error: message is required" }],
        };
      }

      const classification = classifyComplexity(message);
      const suggestion = suggestModelTier(classification.tier);

      const lines: string[] = [];
      lines.push("## 🎯 Task Classification");
      lines.push("");
      lines.push(`| Property | Value |`);
      lines.push(`| --- | --- |`);
      lines.push(
        `| Complexity | **${classification.tier}** (score: ${classification.score}/100) |`,
      );
      lines.push(`| Suggested Tier | **${suggestion.preferredTier}** |`);
      lines.push(`| Reasoning | ${suggestion.reasoning} |`);
      lines.push(`| Signals | ${classification.signals.join(", ")} |`);

      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: { classification, suggestion },
      };
    },
  };
}
