/**
 * Formatting utilities for cost summaries and budget status.
 *
 * We intentionally avoid importing from src/ (only plugin-sdk is allowed).
 * Simple USD formatting is reimplemented here.
 */

import type { BudgetStatus, CostSummary } from "./tracker.js";

// ---------------------------------------------------------------------------
// USD formatting
// ---------------------------------------------------------------------------

export function formatUsd(value: number): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  if (value > 0) {
    return `$${value.toFixed(4)}`;
  }
  return "$0.00";
}

// ---------------------------------------------------------------------------
// Provider breakdown
// ---------------------------------------------------------------------------

export function formatProviderBreakdown(byProvider: Map<string, number>): string {
  if (byProvider.size === 0) {
    return "  (no usage recorded)";
  }
  const lines: string[] = [];
  const sorted = [...byProvider.entries()].sort((a, b) => b[1] - a[1]);
  for (const [provider, amount] of sorted) {
    lines.push(`  ${provider}: ${formatUsd(amount)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Budget status
// ---------------------------------------------------------------------------

export function formatBudgetStatus(status: BudgetStatus): string {
  const lines: string[] = [];

  const icon = status.level === "exceeded" ? "🚫" : status.level === "warning" ? "⚠️" : "✅";
  lines.push(`${icon} Status: ${status.level.toUpperCase()}`);

  lines.push(
    `Daily:   ${formatUsd(status.dailyUsed)} / ${formatUsd(status.dailyLimit)} (${(status.dailyPercent * 100).toFixed(0)}%)`,
  );
  lines.push(
    `Monthly: ${formatUsd(status.monthlyUsed)} / ${formatUsd(status.monthlyLimit)} (${(status.monthlyPercent * 100).toFixed(0)}%)`,
  );

  if (status.exceededProvider) {
    lines.push(`Provider exceeded: ${status.exceededProvider}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full summary
// ---------------------------------------------------------------------------

export function formatCostSummary(summary: CostSummary): string {
  const lines: string[] = [];

  lines.push("📊 Cost Guard — Usage Summary");
  lines.push("─".repeat(35));
  lines.push(`Today:   ${formatUsd(summary.todayUsd)}`);
  lines.push(`Month:   ${formatUsd(summary.monthUsd)}`);
  lines.push(`Entries: ${summary.entryCount}`);
  lines.push("");
  lines.push("Today by provider:");
  lines.push(formatProviderBreakdown(summary.todayByProvider));
  lines.push("");
  lines.push("Month by provider:");
  lines.push(formatProviderBreakdown(summary.monthByProvider));

  return lines.join("\n");
}
