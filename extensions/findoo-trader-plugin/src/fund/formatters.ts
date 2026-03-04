import type { FundRiskStatus, FundState, LeaderboardEntry, Allocation } from "./types.js";

// ── Telegram-friendly text formatters for bot commands ──

const RISK_EMOJI: Record<string, string> = {
  normal: "🟢",
  caution: "🟡",
  warning: "🟠",
  critical: "🔴",
};

/** Format number with comma separators. */
function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/** Format a signed number with +/- prefix. */
function signed(n: number, decimals = 2): string {
  const prefix = n >= 0 ? "+" : "";
  return prefix + fmt(n, decimals);
}

// ── /fund ──

export interface FundStatusData {
  totalEquity: number;
  todayPnl: number;
  todayPnlPct: number;
  riskLevel: string;
  dailyDrawdown: number;
  byLevel: {
    L3_LIVE: number;
    L2_PAPER: number;
    L1_BACKTEST: number;
    L0_INCUBATE: number;
    KILLED: number;
  };
  allocationCount: number;
  lastRebalanceAt: string;
}

export function formatFundStatus(data: FundStatusData): string {
  const riskEmoji = RISK_EMOJI[data.riskLevel] ?? "⚪";
  const lines = [
    "🏦 *FinClaw Fund Status*",
    "",
    `💰 Equity:   $${fmt(data.totalEquity)}`,
    `📈 Today:    ${signed(data.todayPnl)} (${signed(data.todayPnlPct, 1)}%)`,
    `${riskEmoji} Risk:     ${data.riskLevel} (DD: -${fmt(data.dailyDrawdown, 1)}%)`,
    "",
    "Strategies:",
    `  L3 Live:    ${data.byLevel.L3_LIVE}`,
    `  L2 Paper:   ${data.byLevel.L2_PAPER}`,
    `  L1 Test:    ${data.byLevel.L1_BACKTEST}`,
    `  Incubate:   ${data.byLevel.L0_INCUBATE}`,
    `  Killed:     ${data.byLevel.KILLED}`,
    "",
    `Last Rebalance: ${data.lastRebalanceAt}`,
  ];
  return lines.join("\n");
}

// ── /risk ──

export function formatRiskStatus(
  risk: FundRiskStatus,
  scaleFactor: number,
  actions: string[],
): string {
  const riskEmoji = RISK_EMOJI[risk.riskLevel] ?? "⚪";
  const lines = [
    "🛡️ *Fund Risk Status*",
    "",
    `${riskEmoji} Level:       ${risk.riskLevel.toUpperCase()}`,
    `📉 Daily DD:    -${fmt(risk.dailyDrawdown, 1)}% / ${fmt(risk.maxAllowedDrawdown, 0)}%`,
    `💰 Equity:      $${fmt(risk.totalEquity)}`,
    `📊 Exposure:    ${fmt(risk.exposurePct, 1)}%`,
    `💵 Cash:        ${fmt(risk.cashReservePct, 1)}%`,
    `⚖️ Scale:       ${(scaleFactor * 100).toFixed(0)}%`,
    "",
    "Recommended Actions:",
  ];

  for (const action of actions) {
    lines.push(`  • ${action}`);
  }

  return lines.join("\n");
}

// ── /lb ──

export function formatLeaderboard(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) {
    return "📊 *Strategy Leaderboard*\n\nNo eligible strategies found.";
  }

  const lines = [
    "📊 *Strategy Leaderboard*",
    "",
    "```",
    padRow(["#", "Name", "Lvl", "Score", "Sharpe", "MaxDD", "Win"]),
    "─".repeat(62),
  ];

  for (const e of entries.slice(0, 15)) {
    const lvl = e.level.replace("_", "").slice(0, 3);
    lines.push(
      padRow([
        String(e.rank),
        truncate(e.strategyName, 16),
        lvl,
        e.leaderboardScore.toFixed(2),
        e.sharpe.toFixed(2),
        `${e.maxDrawdown.toFixed(1)}%`,
        String(e.totalTrades),
      ]),
    );
  }

  lines.push("```");

  if (entries.length > 15) {
    lines.push(`\n_...and ${entries.length - 15} more_`);
  }

  return lines.join("\n");
}

// ── /alloc ──

export function formatAllocations(allocations: Allocation[], totalCapital: number): string {
  if (allocations.length === 0) {
    return "💼 *Capital Allocations*\n\nNo allocations yet. Run rebalance first.";
  }

  const totalAllocated = allocations.reduce((sum, a) => sum + a.capitalUsd, 0);
  const cashReserve = totalCapital - totalAllocated;
  const cashPct = totalCapital > 0 ? (cashReserve / totalCapital) * 100 : 0;

  const lines = [
    "💼 *Capital Allocations*",
    "",
    `Total Capital: $${fmt(totalCapital)}`,
    `Allocated:     $${fmt(totalAllocated)} (${fmt((totalAllocated / totalCapital) * 100, 1)}%)`,
    `Cash Reserve:  $${fmt(cashReserve)} (${fmt(cashPct, 1)}%)`,
    "",
    "```",
    padRow(["Strategy", "Amount", "Weight", "Reason"]),
    "─".repeat(60),
  ];

  for (const a of allocations) {
    lines.push(
      padRow([
        truncate(a.strategyId, 14),
        `$${fmt(a.capitalUsd, 0)}`,
        `${a.weightPct.toFixed(1)}%`,
        truncate(a.reason, 14),
      ]),
    );
  }

  lines.push("```");
  return lines.join("\n");
}

// ── /promote ──

export interface PromoteCheckData {
  strategyId: string;
  currentLevel: string;
  eligible: boolean;
  targetLevel?: string;
  reasons: string[];
  blockers: string[];
}

export function formatPromoteCheck(data: PromoteCheckData): string {
  const statusEmoji = data.eligible ? "✅" : "❌";
  const lines = [
    `${statusEmoji} *Promotion Check: ${data.strategyId}*`,
    "",
    `Current Level: ${data.currentLevel}`,
  ];

  if (data.eligible && data.targetLevel) {
    lines.push(`Target Level:  ${data.targetLevel}`);
    lines.push("");
    lines.push("Reasons:");
    for (const r of data.reasons) {
      lines.push(`  ✓ ${r}`);
    }
  } else {
    lines.push("");
    lines.push("Blockers:");
    for (const b of data.blockers) {
      lines.push(`  ✗ ${b}`);
    }
    if (data.reasons.length > 0) {
      lines.push("");
      lines.push("Met Criteria:");
      for (const r of data.reasons) {
        lines.push(`  ✓ ${r}`);
      }
    }
  }

  return lines.join("\n");
}

// ── Helpers ──

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function padRow(cols: string[]): string {
  const widths = [4, 16, 6, 8, 8, 8, 6];
  return cols
    .map((c, i) => c.padEnd(widths[i] ?? 10))
    .join(" ")
    .trimEnd();
}
