import type { InsightsReport, PluginReport, VerdictLevel } from "../types.js";

const VERDICT_COLORS: Record<VerdictLevel, string> = {
  keep: "#22c55e",
  low_usage: "#f59e0b",
  expensive: "#ef4444",
  low_satisfaction: "#ef4444",
  remove: "#ef4444",
};

export function generateHTMLReport(
  report: InsightsReport,
  unmappedTools?: { toolName: string; count: number }[]
): string {
  const pluginCards = report.plugins.map(generatePluginCard).join("\n");
  const coverageBanner = generateCoverageBanner(unmappedTools);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Plugin Insights Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0; padding: 2rem;
    }
    .header {
      text-align: center; margin-bottom: 2rem; padding: 2rem;
      background: linear-gradient(135deg, #1e293b, #334155);
      border-radius: 12px; border: 1px solid #475569;
    }
    .header h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
    .header .period { color: #94a3b8; font-size: 0.9rem; }
    .coverage-warning {
      margin-bottom: 1.5rem; padding: 1rem 1.5rem;
      background: #422006; border: 1px solid #92400e; border-radius: 8px;
      color: #fbbf24; font-size: 0.9rem;
    }
    .coverage-warning strong { color: #fde68a; }
    .coverage-warning .tool-list { color: #d4d4d8; margin-top: 0.5rem; font-size: 0.85rem; }
    .grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 1.5rem;
    }
    .card {
      background: #1e293b; border-radius: 12px; padding: 1.5rem;
      border: 1px solid #334155; transition: transform 0.2s;
    }
    .card:hover { transform: translateY(-2px); border-color: #475569; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .card-header h2 { font-size: 1.2rem; }
    .badge {
      padding: 0.25rem 0.75rem; border-radius: 99px; font-size: 0.75rem;
      font-weight: 600;
    }
    .metric { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #334155; }
    .metric:last-child { border-bottom: none; }
    .metric-label { color: #94a3b8; }
    .metric-value { font-weight: 600; }
    .verdict { margin-top: 1rem; padding: 0.75rem; border-radius: 8px; font-weight: 600; text-align: center; }
    .trend-bar { display: flex; gap: 2px; height: 24px; align-items: flex-end; margin-top: 0.5rem; }
    .trend-bar .bar {
      flex: 1; background: #3b82f6; border-radius: 2px 2px 0 0;
      min-width: 4px; transition: height 0.3s;
    }
    .footer { text-align: center; color: #64748b; margin-top: 2rem; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Plugin Insights Dashboard</h1>
    <div class="period">Period: ${report.periodStart} &rarr; ${report.periodEnd}</div>
    <div class="period">Generated: ${report.generatedAt}</div>
  </div>
  ${coverageBanner}
  <div class="grid">
    ${pluginCards}
  </div>
  <div class="footer">
    Plugin Insights &mdash; Data stored locally. No telemetry.
  </div>
</body>
</html>`;
}

function generatePluginCard(plugin: PluginReport): string {
  const name = plugin.pluginName ?? plugin.pluginId;
  const verdictColor = VERDICT_COLORS[plugin.verdict.level];
  const tf = plugin.triggerFrequency;
  const td = plugin.tokenDelta;
  const ct = plugin.conversationTurns;
  const is = plugin.implicitSatisfaction;

  // Generate sparkline for daily trend
  const trendBars = generateTrendBars(tf.dailyTrend);

  let metricsHTML = `
    <div class="metric">
      <span class="metric-label">Triggers</span>
      <span class="metric-value">${tf.totalTriggers} (${tf.triggersPerDay}/day)</span>
    </div>
    <div class="metric">
      <span class="metric-label">Token overhead</span>
      <span class="metric-value">${td.deltaPercent >= 0 ? "+" : ""}${td.deltaPercent}% (~$${td.estimatedMonthlyCostUSD}/mo)</span>
    </div>`;

  if (ct.avgTurnsWithPlugin > 0 || ct.avgTurnsWithoutPlugin > 0) {
    const arrow = ct.deltaPercent < 0 ? "&#9660;" : ct.deltaPercent > 0 ? "&#9650;" : "&mdash;";
    metricsHTML += `
    <div class="metric">
      <span class="metric-label">Avg turns/session</span>
      <span class="metric-value">${ct.avgTurnsWithoutPlugin} &rarr; ${ct.avgTurnsWithPlugin} (${arrow}${Math.abs(ct.deltaPercent)}%)</span>
    </div>`;
  }

  if (is.totalSignals > 0) {
    metricsHTML += `
    <div class="metric">
      <span class="metric-label">Acceptance rate</span>
      <span class="metric-value">${is.acceptanceRate}%</span>
    </div>`;
  }

  if (plugin.llmJudge && plugin.llmJudge.sampleCount > 0) {
    const lj = plugin.llmJudge;
    metricsHTML += `
    <div class="metric">
      <span class="metric-label">LLM Judge score</span>
      <span class="metric-value">${lj.avgScoreWithPlugin}/5 (baseline: ${lj.avgScoreWithoutPlugin})</span>
    </div>`;
  }

  return `
    <div class="card">
      <div class="card-header">
        <h2>${escapeHTML(name)}</h2>
        <span class="badge" style="background:${verdictColor}20;color:${verdictColor}">
          ${plugin.installedDays}d installed
        </span>
      </div>
      ${metricsHTML}
      ${trendBars}
      <div class="verdict" style="background:${verdictColor}15;color:${verdictColor};border:1px solid ${verdictColor}40">
        ${escapeHTML(plugin.verdict.label)}
      </div>
    </div>`;
}

function generateTrendBars(
  trend: { date: string; count: number }[]
): string {
  if (trend.length === 0) return "";

  const max = Math.max(...trend.map((t) => t.count), 1);
  const bars = trend
    .slice(-14) // Show last 14 days
    .map(
      (t) =>
        `<div class="bar" style="height:${Math.max((t.count / max) * 24, 2)}px" title="${t.date}: ${t.count}"></div>`
    )
    .join("");

  return `<div class="trend-bar">${bars}</div>`;
}

function generateCoverageBanner(
  unmappedTools?: { toolName: string; count: number }[]
): string {
  if (!unmappedTools || unmappedTools.length === 0) return "";

  const totalCalls = unmappedTools.reduce((sum, t) => sum + t.count, 0);
  const toolItems = unmappedTools
    .map((t) => `<code>${escapeHTML(t.toolName)}</code> (${t.count}x)`)
    .join(", ");

  return `
  <div class="coverage-warning">
    <strong>&#9888; Partial coverage:</strong> ${unmappedTools.length} tool(s) observed but not mapped to any plugin (${totalCalls} total calls).
    This dashboard only reflects plugins with configured <code>toolMappings</code>.
    <div class="tool-list">Unmapped: ${toolItems}</div>
  </div>`;
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
