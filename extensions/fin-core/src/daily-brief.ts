/**
 * Daily brief generator for fin-core.
 * Aggregates portfolio, events, strategies, and market status into a concise summary.
 */

import type { MarketType } from "./types.js";
import { isMarketOpen } from "./market-rules.js";

// ── Types ──

export type DailyBrief = {
  date: string; // "YYYY-MM-DD"
  summary: string; // 1-2 sentence overview
  content: string; // Multi-paragraph text for dashboard rendering
  portfolio: {
    totalEquity: number;
    dailyPnl: number;
    dailyPnlPct: number;
  };
  topEvents: Array<{
    title: string;
    type: string;
    timestamp: number;
  }>;
  strategyHighlights: Array<{
    name: string;
    level: string;
    status: string;
    pnl: number;
  }>;
  marketStatus: Array<{
    market: MarketType;
    isOpen: boolean;
  }>;
  riskAlerts: string[];
  generatedAt: number;
};

export interface BriefDataSource {
  getRecentEvents(
    limit: number,
  ): Promise<
    Array<{
      id: string;
      type: string;
      title: string;
      detail: string;
      timestamp: number;
      status: string;
    }>
  >;
  getPortfolioSummary(): Promise<{ totalEquity: number; dailyPnl: number } | null>;
  getStrategies(): Promise<Array<{ name: string; level: string; status: string; pnl: number }>>;
}

// ── Constants ──

const ALL_MARKETS: MarketType[] = ["crypto", "us-equity", "hk-equity", "cn-a-share"];
const MAX_TOP_EVENTS = 5;

// ── Generator ──

export class DailyBriefGenerator {
  private cachedBrief: DailyBrief | null = null;

  constructor(private dataSource: BriefDataSource) {}

  async generate(): Promise<DailyBrief> {
    const [events, portfolio, strategies] = await Promise.all([
      this.dataSource.getRecentEvents(20),
      this.dataSource.getPortfolioSummary(),
      this.dataSource.getStrategies(),
    ]);

    const now = Date.now();

    // Portfolio with fallback
    const totalEquity = portfolio?.totalEquity ?? 0;
    const dailyPnl = portfolio?.dailyPnl ?? 0;
    const baseEquity = totalEquity - dailyPnl;
    const dailyPnlPct = baseEquity > 0 ? (dailyPnl / baseEquity) * 100 : 0;

    // Top events: sort by timestamp desc, take top 5
    const sortedEvents = [...events].sort((a, b) => b.timestamp - a.timestamp);
    const topEvents = sortedEvents.slice(0, MAX_TOP_EVENTS).map((e) => ({
      title: e.title,
      type: e.type,
      timestamp: e.timestamp,
    }));

    // Strategy highlights
    const strategyHighlights = strategies.map((s) => ({
      name: s.name,
      level: s.level,
      status: s.status,
      pnl: s.pnl,
    }));

    // Market status
    const marketStatus = ALL_MARKETS.map((market) => ({
      market,
      isOpen: isMarketOpen(market, now),
    }));

    // Risk alerts
    const riskAlerts = buildRiskAlerts(events, dailyPnl);

    // Summary
    const summary = portfolio
      ? buildSummary(totalEquity, dailyPnl, dailyPnlPct, strategies.length, events)
      : "No portfolio data available. Configure exchanges to get started.";

    const content = buildContent(summary, strategyHighlights, riskAlerts, marketStatus);

    const brief: DailyBrief = {
      date: formatDate(now),
      summary,
      content,
      portfolio: { totalEquity, dailyPnl, dailyPnlPct },
      topEvents,
      strategyHighlights,
      marketStatus,
      riskAlerts,
      generatedAt: now,
    };

    this.cachedBrief = brief;
    return brief;
  }

  getCachedBrief(): DailyBrief | null {
    return this.cachedBrief;
  }
}

// ── Internal helpers ──

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function buildSummary(
  equity: number,
  pnl: number,
  pnlPct: number,
  strategyCount: number,
  events: Array<{ status: string }>,
): string {
  const sign = pnl >= 0 ? "+" : "";
  const pendingCount = events.filter((e) => e.status === "pending").length;
  return `Portfolio: ${formatUsd(equity)} (${sign}${pnlPct.toFixed(2)}%). ${strategyCount} strategies active. ${pendingCount} pending events.`;
}

function buildContent(
  summary: string,
  strategies: Array<{ name: string; level: string; status: string; pnl: number }>,
  riskAlerts: string[],
  marketStatus: Array<{ market: MarketType; isOpen: boolean }>,
): string {
  const sections: string[] = [summary];

  if (strategies.length > 0) {
    const stratLines = strategies
      .map((s) => `${s.name} [${s.level}] — ${s.status}, PnL: ${formatUsd(s.pnl)}`)
      .join(", ");
    sections.push(`Strategies: ${stratLines}`);
  }

  const openMarkets = marketStatus.filter((m) => m.isOpen).map((m) => m.market);
  sections.push(
    openMarkets.length > 0
      ? `Markets open: ${openMarkets.join(", ")}`
      : "All traditional markets closed",
  );

  if (riskAlerts.length > 0) {
    sections.push(`Risk alerts: ${riskAlerts.join("; ")}`);
  }

  return sections.join("\n\n");
}

function buildRiskAlerts(
  events: Array<{ type: string; title: string }>,
  dailyPnl: number,
): string[] {
  const alerts: string[] = [];

  // Check for emergency events
  const emergencies = events.filter((e) => e.type === "emergency_stop");
  if (emergencies.length > 0) {
    alerts.push(
      `${emergencies.length} emergency stop event(s) detected: ${emergencies.map((e) => e.title).join(", ")}`,
    );
  }

  // Significant daily loss warning
  if (dailyPnl < -500) {
    alerts.push(`Significant daily loss: ${formatUsd(Math.abs(dailyPnl))}`);
  }

  return alerts;
}
