/**
 * Active Memory Statistics & Analytics
 * 
 * Provides comprehensive analytics for memory usage patterns,
 * recall performance, and cache effectiveness.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface MemoryStats {
  totalRecalls: number;
  successfulRecalls: number;
  emptyRecalls: number;
  timeoutRecalls: number;
  failedRecalls: number;
  cacheHits: number;
  cacheMisses: number;
  averageRecallTimeMs: number;
  totalRecallTimeMs: number;
  lastRecallAt?: number;
  topQueryPatterns: Array<{ pattern: string; count: number }>;
  memoryHitRate: number;
  cacheHitRate: number;
}

export interface MemoryAnalytics {
  dailyStats: Record<string, MemoryStats>;
  hourlyDistribution: number[];
  agentStats: Record<string, MemoryStats>;
  trendingQueries: Array<{ query: string; trend: "up" | "down" | "stable"; changePercent: number }>;
}

const STATS_FILE = "memory-stats.json";
const MAX_QUERY_PATTERNS = 50;
const ANALYTICS_RETENTION_DAYS = 30;

function getStatsFilePath(api: OpenClawPluginApi): string {
  return path.join(
    api.runtime.state.resolveStateDir(),
    "plugins",
    "active-memory",
    STATS_FILE
  );
}

function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

function getHourIndex(): number {
  return new Date().getHours();
}

export async function loadMemoryStats(api: OpenClawPluginApi): Promise<MemoryAnalytics> {
  try {
    const statsPath = getStatsFilePath(api);
    const raw = await fs.readFile(statsPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryAnalytics;
    return cleanupOldStats(parsed);
  } catch {
    return createEmptyAnalytics();
  }
}

function createEmptyAnalytics(): MemoryAnalytics {
  return {
    dailyStats: {},
    hourlyDistribution: new Array(24).fill(0),
    agentStats: {},
    trendingQueries: [],
  };
}

function cleanupOldStats(analytics: MemoryAnalytics): MemoryAnalytics {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ANALYTICS_RETENTION_DAYS);
  const cutoffKey = cutoffDate.toISOString().split("T")[0];

  const cleanedDailyStats: Record<string, MemoryStats> = {};
  for (const [date, stats] of Object.entries(analytics.dailyStats)) {
    if (date >= cutoffKey) {
      cleanedDailyStats[date] = stats;
    }
  }

  return {
    ...analytics,
    dailyStats: cleanedDailyStats,
  };
}

export async function saveMemoryStats(
  api: OpenClawPluginApi,
  analytics: MemoryAnalytics
): Promise<void> {
  const statsPath = getStatsFilePath(api);
  await fs.mkdir(path.dirname(statsPath), { recursive: true });
  await fs.writeFile(statsPath, JSON.stringify(analytics, null, 2));
}

export async function recordMemoryRecall(params: {
  api: OpenClawPluginApi;
  agentId: string;
  status: "ok" | "empty" | "timeout" | "unavailable";
  elapsedMs: number;
  query: string;
  cached: boolean;
}): Promise<void> {
  const analytics = await loadMemoryStats(params.api);
  const today = getTodayKey();
  const hour = getHourIndex();

  // Update hourly distribution
  analytics.hourlyDistribution[hour]++;

  // Update daily stats
  const dailyStats = analytics.dailyStats[today] ?? createEmptyStats();
  dailyStats.totalRecalls++;
  dailyStats.totalRecallTimeMs += params.elapsedMs;
  dailyStats.averageRecallTimeMs =
    dailyStats.totalRecallTimeMs / dailyStats.totalRecalls;
  dailyStats.lastRecallAt = Date.now();

  if (params.cached) {
    dailyStats.cacheHits++;
  } else {
    dailyStats.cacheMisses++;
  }

  switch (params.status) {
    case "ok":
      dailyStats.successfulRecalls++;
      break;
    case "empty":
      dailyStats.emptyRecalls++;
      break;
    case "timeout":
      dailyStats.timeoutRecalls++;
      break;
    case "unavailable":
      dailyStats.failedRecalls++;
      break;
  }

  // Calculate rates
  const totalHits = dailyStats.successfulRecalls + dailyStats.emptyRecalls;
  dailyStats.memoryHitRate =
    dailyStats.totalRecalls > 0 ? totalHits / dailyStats.totalRecalls : 0;
  dailyStats.cacheHitRate =
    dailyStats.cacheHits + dailyStats.cacheMisses > 0
      ? dailyStats.cacheHits / (dailyStats.cacheHits + dailyStats.cacheMisses)
      : 0;

  // Update query patterns
  updateQueryPatterns(dailyStats, params.query);
  analytics.dailyStats[today] = dailyStats;

  // Update agent stats
  const agentStats = analytics.agentStats[params.agentId] ?? createEmptyStats();
  agentStats.totalRecalls++;
  agentStats.totalRecallTimeMs += params.elapsedMs;
  agentStats.averageRecallTimeMs =
    agentStats.totalRecallTimeMs / agentStats.totalRecalls;

  if (params.cached) {
    agentStats.cacheHits++;
  } else {
    agentStats.cacheMisses++;
  }

  switch (params.status) {
    case "ok":
      agentStats.successfulRecalls++;
      break;
    case "empty":
      agentStats.emptyRecalls++;
      break;
    case "timeout":
      agentStats.timeoutRecalls++;
      break;
    case "unavailable":
      agentStats.failedRecalls++;
      break;
  }

  const agentTotalHits = agentStats.successfulRecalls + agentStats.emptyRecalls;
  agentStats.memoryHitRate =
    agentStats.totalRecalls > 0 ? agentTotalHits / agentStats.totalRecalls : 0;
  agentStats.cacheHitRate =
    agentStats.cacheHits + agentStats.cacheMisses > 0
      ? agentStats.cacheHits / (agentStats.cacheHits + agentStats.cacheMisses)
      : 0;

  updateQueryPatterns(agentStats, params.query);
  analytics.agentStats[params.agentId] = agentStats;

  // Update trending queries
  analytics.trendingQueries = calculateTrendingQueries(analytics);

  await saveMemoryStats(params.api, analytics);
}

function createEmptyStats(): MemoryStats {
  return {
    totalRecalls: 0,
    successfulRecalls: 0,
    emptyRecalls: 0,
    timeoutRecalls: 0,
    failedRecalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageRecallTimeMs: 0,
    totalRecallTimeMs: 0,
    topQueryPatterns: [],
    memoryHitRate: 0,
    cacheHitRate: 0,
  };
}

function updateQueryPatterns(stats: MemoryStats, query: string): void {
  // Extract key terms from query (simplified pattern extraction)
  const normalizedQuery = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .trim();

  if (!normalizedQuery) return;

  // Check for existing similar patterns
  const existingPattern = stats.topQueryPatterns.find(
    (p) => p.pattern === normalizedQuery
  );

  if (existingPattern) {
    existingPattern.count++;
  } else {
    stats.topQueryPatterns.push({ pattern: normalizedQuery, count: 1 });
  }

  // Sort by count and limit
  stats.topQueryPatterns.sort((a, b) => b.count - a.count);
  if (stats.topQueryPatterns.length > MAX_QUERY_PATTERNS) {
    stats.topQueryPatterns = stats.topQueryPatterns.slice(0, MAX_QUERY_PATTERNS);
  }
}

function calculateTrendingQueries(
  analytics: MemoryAnalytics
): Array<{ query: string; trend: "up" | "down" | "stable"; changePercent: number }> {
  const dates = Object.keys(analytics.dailyStats).sort();
  if (dates.length < 2) return [];

  const currentDate = dates[dates.length - 1];
  const previousDate = dates[dates.length - 2];
  const currentStats = analytics.dailyStats[currentDate];
  const previousStats = analytics.dailyStats[previousDate];

  if (!currentStats || !previousStats) return [];

  const trends: Array<{
    query: string;
    trend: "up" | "down" | "stable";
    changePercent: number;
  }> = [];

  // Compare patterns between days
  for (const currentPattern of currentStats.topQueryPatterns.slice(0, 10)) {
    const previousPattern = previousStats.topQueryPatterns.find(
      (p) => p.pattern === currentPattern.pattern
    );

    const previousCount = previousPattern?.count ?? 0;
    const changePercent =
      previousCount > 0
        ? ((currentPattern.count - previousCount) / previousCount) * 100
        : currentPattern.count > 0
          ? 100
          : 0;

    let trend: "up" | "down" | "stable" = "stable";
    if (changePercent > 20) trend = "up";
    else if (changePercent < -20) trend = "down";

    trends.push({
      query: currentPattern.pattern,
      trend,
      changePercent,
    });
  }

  return trends.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

export function formatMemoryStatsReport(analytics: MemoryAnalytics): string {
  const today = getTodayKey();
  const todayStats = analytics.dailyStats[today];

  if (!todayStats) {
    return "📊 No memory statistics available for today.";
  }

  const lines = [
    "📊 Active Memory Statistics (Today)",
    "",
    `🎯 Total Recalls: ${todayStats.totalRecalls}`,
    `✅ Successful: ${todayStats.successfulRecalls}`,
    `📭 Empty Results: ${todayStats.emptyRecalls}`,
    `⏱️ Timeouts: ${todayStats.timeoutRecalls}`,
    `❌ Failed: ${todayStats.failedRecalls}`,
    "",
    `📈 Memory Hit Rate: ${(todayStats.memoryHitRate * 100).toFixed(1)}%`,
    `💾 Cache Hit Rate: ${(todayStats.cacheHitRate * 100).toFixed(1)}%`,
    `⚡ Avg Response Time: ${todayStats.averageRecallTimeMs.toFixed(0)}ms`,
  ];

  if (todayStats.topQueryPatterns.length > 0) {
    lines.push("", "🔍 Top Query Patterns:");
    for (const pattern of todayStats.topQueryPatterns.slice(0, 5)) {
      lines.push(`  • "${pattern.pattern}" (${pattern.count} times)`);
    }
  }

  if (analytics.trendingQueries.length > 0) {
    lines.push("", "📈 Trending Queries:");
    for (const trend of analytics.trendingQueries.slice(0, 5)) {
      const emoji = trend.trend === "up" ? "📈" : trend.trend === "down" ? "📉" : "➡️";
      lines.push(`  ${emoji} "${trend.query}" (${trend.changePercent > 0 ? "+" : ""}${trend.changePercent.toFixed(0)}%)`);
    }
  }

  // Hourly distribution chart
  lines.push("", "⏰ Hourly Activity:");
  const maxHourly = Math.max(...analytics.hourlyDistribution, 1);
  for (let i = 0; i < 24; i += 4) {
    const block = analytics.hourlyDistribution.slice(i, i + 4);
    const blockTotal = block.reduce((a, b) => a + b, 0);
    const barLength = Math.round((blockTotal / maxHourly) * 10);
    const bar = "█".repeat(barLength) + "░".repeat(10 - barLength);
    lines.push(`  ${i.toString().padStart(2, "0")}:00-${(i + 4).toString().padStart(2, "0")}:00 ${bar} ${blockTotal}`);
  }

  return lines.join("\n");
}

export async function getMemoryStatsForAgent(
  api: OpenClawPluginApi,
  agentId: string
): Promise<MemoryStats | undefined> {
  const analytics = await loadMemoryStats(api);
  return analytics.agentStats[agentId];
}

export async function getOverallMemoryStats(
  api: OpenClawPluginApi
): Promise<MemoryStats> {
  const analytics = await loadMemoryStats(api);
  const today = getTodayKey();
  return (
    analytics.dailyStats[today] ?? {
      totalRecalls: 0,
      successfulRecalls: 0,
      emptyRecalls: 0,
      timeoutRecalls: 0,
      failedRecalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      averageRecallTimeMs: 0,
      totalRecallTimeMs: 0,
      topQueryPatterns: [],
      memoryHitRate: 0,
      cacheHitRate: 0,
    }
  );
}

export async function resetMemoryStats(api: OpenClawPluginApi): Promise<void> {
  const emptyAnalytics = createEmptyAnalytics();
  await saveMemoryStats(api, emptyAnalytics);
}
