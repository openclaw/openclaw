import { describe, it, expect } from "vitest";
import { generateHTMLReport } from "../../src/report/html-report.js";
import type { InsightsReport, PluginReport } from "../../src/types.js";

function makePlugin(): PluginReport {
  return {
    pluginId: "test-plugin",
    pluginName: "Test Plugin",
    installedDays: 30,
    triggerFrequency: {
      pluginId: "test-plugin",
      totalTriggers: 100,
      triggersPerDay: 3.3,
      triggersPerSession: 2.5,
      dailyTrend: [
        { date: "2026-03-15", count: 5 },
        { date: "2026-03-16", count: 3 },
      ],
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
  };
}

describe("HTML Report", () => {
  it("should generate valid HTML", () => {
    const report: InsightsReport = {
      periodStart: "2026-02-14",
      periodEnd: "2026-03-16",
      plugins: [makePlugin()],
      generatedAt: new Date().toISOString(),
    };

    const html = generateHTMLReport(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Plugin Insights Dashboard");
    expect(html).toContain("Test Plugin");
    expect(html).toContain("100 (3.3/day)");
  });

  it("should include trend bars", () => {
    const report: InsightsReport = {
      periodStart: "2026-02-14",
      periodEnd: "2026-03-16",
      plugins: [makePlugin()],
      generatedAt: new Date().toISOString(),
    };

    const html = generateHTMLReport(report);
    expect(html).toContain("trend-bar");
    expect(html).toContain('class="bar"');
  });

  it("should escape HTML in plugin names", () => {
    const plugin = makePlugin();
    plugin.pluginName = '<script>alert("xss")</script>';

    const report: InsightsReport = {
      periodStart: "2026-02-14",
      periodEnd: "2026-03-16",
      plugins: [plugin],
      generatedAt: new Date().toISOString(),
    };

    const html = generateHTMLReport(report);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
