import type { CostUsageSummary } from "../src/infra/session-cost-usage.types.js";
import { UNKNOWN_USAGE_CREATOR_KEY } from "../src/shared/usage-aggregates.js";

function usageCostTotals(totalTokens: number, totalCost = 0) {
  return {
    input: Math.round(totalTokens * 0.2),
    output: Math.round(totalTokens * 0.1),
    cacheRead: Math.round(totalTokens * 0.6),
    cacheWrite: Math.round(totalTokens * 0.1),
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

// Deterministic year of daily activity so the settings profile heatmap,
// streaks, and stat strip render with a lively fixture in the mock harness.
export function buildProfileUsageMocks(baseTime: number) {
  const daily: CostUsageSummary["daily"] = [];
  const sessionCount = 48_212;
  let lifetimeTokens = 0;
  for (let daysAgo = 364; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date(baseTime - daysAgo * 24 * 60 * 60 * 1000);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const weekendDamper = date.getDay() === 0 || date.getDay() === 6 ? 0.3 : 1;
    const quietDay = daysAgo % 19 === 4 ? 0 : 1;
    const wave = (Math.sin(daysAgo / 6) + 1.4) * 1_400_000_000;
    const spike = daysAgo % 47 === 0 ? 6_000_000_000 : 0;
    const tokens = Math.round((wave + spike) * weekendDamper * quietDay);
    lifetimeTokens += tokens;
    daily.push({ date: iso, ...usageCostTotals(tokens, tokens / 1e9) });
  }
  return {
    cost: {
      updatedAt: baseTime,
      days: daily.length,
      daily,
      totals: usageCostTotals(lifetimeTokens, lifetimeTokens / 1e9),
    },
    sessions: {
      updatedAt: baseTime,
      startDate: daily[0]?.date,
      endDate: daily[daily.length - 1]?.date,
      sessions: [
        {
          key: "agent:openclaw-mock:marathon",
          label: "Release night marathon",
          usage: { ...usageCostTotals(4_000_000_000), durationMs: (59 * 60 + 4) * 60 * 1000 },
        },
        {
          key: "agent:openclaw-mock:daily",
          label: "Daily driver",
          usage: { ...usageCostTotals(900_000_000), durationMs: 3 * 60 * 60 * 1000 },
        },
      ],
      totals: usageCostTotals(lifetimeTokens, lifetimeTokens / 1e9),
      creatorOptions: [{ key: UNKNOWN_USAGE_CREATOR_KEY }],
      aggregates: {
        sessionCount,
        byCreator: [
          {
            key: UNKNOWN_USAGE_CREATOR_KEY,
            totals: usageCostTotals(lifetimeTokens, lifetimeTokens / 1e9),
            sessionCount,
            daily,
            // The synthetic history uses one shared activity pattern for its unassigned sessions.
            sessionActivity: [
              {
                dates: daily.filter((day) => day.totalTokens > 0).map((day) => day.date),
                sessionCount,
              },
            ],
          },
        ],
        costDaily: daily,
        longestSessionDurationMs: (59 * 60 + 4) * 60 * 1000,
        messages: {
          total: 2_787_815,
          user: 1_400_000,
          assistant: 1_387_815,
          toolCalls: 42_380,
          toolResults: 42_380,
          errors: 128,
        },
        tools: {
          totalCalls: 42_380,
          uniqueTools: 205,
          tools: [
            { name: "exec", count: 6_418 },
            { name: "browser", count: 5_256 },
            { name: "message", count: 4_708 },
            { name: "read", count: 4_489 },
            { name: "sessions_list", count: 3_066 },
          ],
        },
        byModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            count: 9_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.7)),
          },
          {
            provider: "openai",
            model: "gpt-5-mini",
            count: 4_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.3)),
          },
        ],
        byProvider: [
          {
            provider: "anthropic",
            count: 9_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.7), 184.2),
          },
          {
            provider: "openai",
            count: 4_000,
            totals: usageCostTotals(Math.round(lifetimeTokens * 0.3), 96.4),
          },
        ],
        byAgent: [
          { agentId: "openclaw-mock", totals: usageCostTotals(Math.round(lifetimeTokens * 0.8)) },
          { agentId: "alpha", totals: usageCostTotals(Math.round(lifetimeTokens * 0.2)) },
        ],
        byChannel: [
          { channel: "whatsapp", totals: usageCostTotals(Math.round(lifetimeTokens * 0.5)) },
          { channel: "telegram", totals: usageCostTotals(Math.round(lifetimeTokens * 0.3)) },
          { channel: "discord", totals: usageCostTotals(Math.round(lifetimeTokens * 0.2)) },
        ],
        daily: [],
      },
    },
  };
}
