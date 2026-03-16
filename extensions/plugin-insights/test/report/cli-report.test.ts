import { describe, it, expect } from "vitest";
import { formatCLIReport, formatPluginSummary } from "../../src/report/cli-report.js";
import type { InsightsReport, PluginReport } from "../../src/types.js";

function makePlugin(overrides: Partial<PluginReport> = {}): PluginReport {
  return {
    pluginId: "test-plugin",
    pluginName: "Test Plugin",
    installedDays: 30,
    triggerFrequency: {
      pluginId: "test-plugin",
      totalTriggers: 100,
      triggersPerDay: 3.3,
      triggersPerSession: 2.5,
      dailyTrend: [],
    },
    tokenDelta: {
      pluginId: "test-plugin",
      avgTokensWithPlugin: 1100,
      avgTokensWithoutPlugin: 900,
      deltaTokens: 200,
      deltaPercent: 22.2,
      estimatedMonthlyCostUSD: 0.5,
    },
    conversationTurns: {
      pluginId: "test-plugin",
      avgTurnsWithPlugin: 3.5,
      avgTurnsWithoutPlugin: 5.0,
      deltaTurns: -1.5,
      deltaPercent: -30,
    },
    implicitSatisfaction: {
      pluginId: "test-plugin",
      acceptanceRate: 82,
      retryRate: 12,
      correctionRate: 6,
      totalSignals: 50,
    },
    verdict: {
      level: "keep",
      label: "KEEP — strong positive impact",
      reason: "Good metrics",
    },
    ...overrides,
  };
}

describe("CLI Report", () => {
  it("should format a full report", () => {
    const report: InsightsReport = {
      periodStart: "2026-02-14",
      periodEnd: "2026-03-16",
      plugins: [makePlugin()],
      generatedAt: new Date().toISOString(),
    };

    const output = formatCLIReport(report);
    expect(output).toContain("Plugin Insights Report");
    expect(output).toContain("Test Plugin");
    expect(output).toContain("100 times");
    expect(output).toContain("+22.2%");
    expect(output).toContain("82%");
    expect(output).toContain("KEEP");
  });

  it("should format plugin summary", () => {
    const plugin = makePlugin();
    const output = formatPluginSummary(plugin);
    expect(output).toContain("Test Plugin");
    expect(output).toContain("3.3/day");
  });

  it("should handle multiple plugins", () => {
    const report: InsightsReport = {
      periodStart: "2026-02-14",
      periodEnd: "2026-03-16",
      plugins: [
        makePlugin({ pluginId: "plugin-a", pluginName: "Plugin A" }),
        makePlugin({
          pluginId: "plugin-b",
          pluginName: "Plugin B",
          verdict: { level: "low_usage", label: "LOW USAGE", reason: "Rarely used" },
        }),
      ],
      generatedAt: new Date().toISOString(),
    };

    const output = formatCLIReport(report);
    expect(output).toContain("Plugin A");
    expect(output).toContain("Plugin B");
    expect(output).toContain("LOW USAGE");
  });
});
