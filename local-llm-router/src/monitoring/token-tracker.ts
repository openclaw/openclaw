/**
 * Token usage tracker — logs every model call and calculates costs.
 *
 * Persists to JSONL for historical analysis.
 * Provides aggregation by day, agent, model, and engine.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsageEntry {
  timestamp: string;
  agent: string;
  provider: string;
  model: string;
  engine: "local" | "cloud";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  cached: boolean;
}

export interface UsageSummary {
  period: string;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byAgent: Record<string, { calls: number; tokens: number; costUsd: number }>;
  byModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  byEngine: { local: { calls: number; tokens: number }; cloud: { calls: number; tokens: number; costUsd: number } };
}

export interface BudgetAlert {
  level: "info" | "warning" | "critical";
  message: string;
  currentSpend: number;
  budgetLimit: number;
  percentUsed: number;
}

// ---------------------------------------------------------------------------
// Cost tables (USD per 1M tokens)
// ---------------------------------------------------------------------------

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-4-6":            { input: 15.0,  output: 75.0 },
  "claude-sonnet-4-5-20250929": { input: 3.0,   output: 15.0 },
  "claude-haiku-4-5-20251001":  { input: 0.8,   output: 4.0 },
  // OpenAI
  "gpt-4o":                     { input: 2.5,   output: 10.0 },
  "gpt-4o-mini":                { input: 0.15,  output: 0.60 },
  // Local — free
  "qwen2.5:3b":                 { input: 0,     output: 0 },
  "llama3.1:8b":                { input: 0,     output: 0 },
  "qwen2.5-coder:7b":           { input: 0,     output: 0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_MILLION[model];
  if (!rates) return 0;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Rough token estimation (when provider doesn't return counts)
// ---------------------------------------------------------------------------

/** ~4 chars per token for English text — good enough for estimates */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Token Tracker
// ---------------------------------------------------------------------------

export class TokenTracker {
  private logDir: string;
  private dailyBudgetUsd: number;
  private monthlyBudgetUsd: number;

  constructor(logDir: string, opts?: { dailyBudgetUsd?: number; monthlyBudgetUsd?: number }) {
    this.logDir = logDir;
    this.dailyBudgetUsd = opts?.dailyBudgetUsd ?? 5.0;
    this.monthlyBudgetUsd = opts?.monthlyBudgetUsd ?? 50.0;
  }

  /**
   * Record a model call.
   */
  async record(entry: Omit<TokenUsageEntry, "timestamp" | "totalTokens" | "costUsd">): Promise<TokenUsageEntry> {
    const full: TokenUsageEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      totalTokens: entry.inputTokens + entry.outputTokens,
      costUsd: estimateCost(entry.model, entry.inputTokens, entry.outputTokens),
    };

    await this.appendLog(full);
    return full;
  }

  /**
   * Get usage summary for today.
   */
  async todaySummary(): Promise<UsageSummary> {
    const today = new Date().toISOString().slice(0, 10);
    const entries = await this.readEntriesForDate(today);
    return this.buildSummary(`Today (${today})`, entries);
  }

  /**
   * Get usage summary for the last N days.
   */
  async periodSummary(days: number): Promise<UsageSummary> {
    const entries: TokenUsageEntry[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const dayEntries = await this.readEntriesForDate(dateStr);
      entries.push(...dayEntries);
    }

    return this.buildSummary(`Last ${days} days`, entries);
  }

  /**
   * Check budget status and return alerts if needed.
   */
  async checkBudget(): Promise<BudgetAlert[]> {
    const alerts: BudgetAlert[] = [];

    // Daily check
    const today = await this.todaySummary();
    const dailyPct = (today.totalCostUsd / this.dailyBudgetUsd) * 100;

    if (dailyPct >= 100) {
      alerts.push({
        level: "critical",
        message: `Daily budget exceeded! $${today.totalCostUsd.toFixed(2)} / $${this.dailyBudgetUsd.toFixed(2)}`,
        currentSpend: today.totalCostUsd,
        budgetLimit: this.dailyBudgetUsd,
        percentUsed: dailyPct,
      });
    } else if (dailyPct >= 80) {
      alerts.push({
        level: "warning",
        message: `Daily budget at ${dailyPct.toFixed(0)}%: $${today.totalCostUsd.toFixed(2)} / $${this.dailyBudgetUsd.toFixed(2)}`,
        currentSpend: today.totalCostUsd,
        budgetLimit: this.dailyBudgetUsd,
        percentUsed: dailyPct,
      });
    }

    // Monthly check
    const monthly = await this.periodSummary(30);
    const monthlyPct = (monthly.totalCostUsd / this.monthlyBudgetUsd) * 100;

    if (monthlyPct >= 100) {
      alerts.push({
        level: "critical",
        message: `Monthly budget exceeded! $${monthly.totalCostUsd.toFixed(2)} / $${this.monthlyBudgetUsd.toFixed(2)}`,
        currentSpend: monthly.totalCostUsd,
        budgetLimit: this.monthlyBudgetUsd,
        percentUsed: monthlyPct,
      });
    } else if (monthlyPct >= 80) {
      alerts.push({
        level: "warning",
        message: `Monthly budget at ${monthlyPct.toFixed(0)}%: $${monthly.totalCostUsd.toFixed(2)} / $${this.monthlyBudgetUsd.toFixed(2)}`,
        currentSpend: monthly.totalCostUsd,
        budgetLimit: this.monthlyBudgetUsd,
        percentUsed: monthlyPct,
      });
    }

    return alerts;
  }

  /**
   * Format a summary for Telegram display.
   */
  formatForTelegram(summary: UsageSummary): string {
    const lines: string[] = [
      `Token Usage — ${summary.period}`,
      ``,
      `Calls: ${summary.totalCalls}`,
      `Tokens: ${formatNumber(summary.totalTokens)} (${formatNumber(summary.totalInputTokens)} in / ${formatNumber(summary.totalOutputTokens)} out)`,
      `Cost: $${summary.totalCostUsd.toFixed(4)}`,
      ``,
    ];

    // By engine
    lines.push(`Engine breakdown:`);
    lines.push(`  Local:  ${summary.byEngine.local.calls} calls, ${formatNumber(summary.byEngine.local.tokens)} tokens ($0.00)`);
    lines.push(`  Cloud:  ${summary.byEngine.cloud.calls} calls, ${formatNumber(summary.byEngine.cloud.tokens)} tokens ($${summary.byEngine.cloud.costUsd.toFixed(4)})`);
    lines.push(``);

    // By agent
    if (Object.keys(summary.byAgent).length > 0) {
      lines.push(`By agent:`);
      for (const [agent, data] of Object.entries(summary.byAgent)) {
        lines.push(`  ${agent}: ${data.calls} calls, ${formatNumber(data.tokens)} tokens ($${data.costUsd.toFixed(4)})`);
      }
      lines.push(``);
    }

    // By model
    if (Object.keys(summary.byModel).length > 0) {
      lines.push(`By model:`);
      for (const [model, data] of Object.entries(summary.byModel)) {
        const shortModel = model.split("/").pop() ?? model;
        lines.push(`  ${shortModel}: ${data.calls} calls ($${data.costUsd.toFixed(4)})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Format budget alerts for Telegram.
   */
  formatAlertsForTelegram(alerts: BudgetAlert[]): string {
    if (alerts.length === 0) {
      return "Budget: All clear — no alerts.";
    }
    return alerts.map((a) => {
      const icon = a.level === "critical" ? "ALERT" : a.level === "warning" ? "WARNING" : "INFO";
      return `[${icon}] ${a.message}`;
    }).join("\n");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async appendLog(entry: TokenUsageEntry): Promise<void> {
    const dateStr = entry.timestamp.slice(0, 10);
    const dir = path.join(this.logDir, dateStr.slice(0, 7)); // YYYY-MM subdirs
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${dateStr}.jsonl`);
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(filePath, line, "utf-8");
  }

  private async readEntriesForDate(dateStr: string): Promise<TokenUsageEntry[]> {
    const monthDir = dateStr.slice(0, 7);
    const filePath = path.join(this.logDir, monthDir, `${dateStr}.jsonl`);

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TokenUsageEntry);
    } catch {
      return [];
    }
  }

  private buildSummary(period: string, entries: TokenUsageEntry[]): UsageSummary {
    const summary: UsageSummary = {
      period,
      totalCalls: entries.length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      byAgent: {},
      byModel: {},
      byEngine: {
        local: { calls: 0, tokens: 0 },
        cloud: { calls: 0, tokens: 0, costUsd: 0 },
      },
    };

    for (const e of entries) {
      summary.totalInputTokens += e.inputTokens;
      summary.totalOutputTokens += e.outputTokens;
      summary.totalTokens += e.totalTokens;
      summary.totalCostUsd += e.costUsd;

      // By agent
      if (!summary.byAgent[e.agent]) {
        summary.byAgent[e.agent] = { calls: 0, tokens: 0, costUsd: 0 };
      }
      summary.byAgent[e.agent].calls++;
      summary.byAgent[e.agent].tokens += e.totalTokens;
      summary.byAgent[e.agent].costUsd += e.costUsd;

      // By model
      if (!summary.byModel[e.model]) {
        summary.byModel[e.model] = { calls: 0, tokens: 0, costUsd: 0 };
      }
      summary.byModel[e.model].calls++;
      summary.byModel[e.model].tokens += e.totalTokens;
      summary.byModel[e.model].costUsd += e.costUsd;

      // By engine
      if (e.engine === "local") {
        summary.byEngine.local.calls++;
        summary.byEngine.local.tokens += e.totalTokens;
      } else {
        summary.byEngine.cloud.calls++;
        summary.byEngine.cloud.tokens += e.totalTokens;
        summary.byEngine.cloud.costUsd += e.costUsd;
      }
    }

    return summary;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
