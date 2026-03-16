import type { InsightsReport, PluginReport, VerdictLevel } from "../types.js";

const VERDICT_ICONS: Record<VerdictLevel, string> = {
  keep: "✅",
  low_usage: "⚠️ ",
  expensive: "❌",
  low_satisfaction: "❌",
  remove: "❌",
};

export function formatCLIReport(report: InsightsReport): string {
  const lines: string[] = [];
  const W = 56;

  lines.push("╔" + "═".repeat(W) + "╗");
  lines.push("║" + center("Plugin Insights Report", W) + "║");
  lines.push(
    "║" +
      center(`Period: ${report.periodStart} → ${report.periodEnd}`, W) +
      "║"
  );
  lines.push("╠" + "═".repeat(W) + "╣");
  lines.push("║" + " ".repeat(W) + "║");

  for (const plugin of report.plugins) {
    lines.push(...formatPluginSection(plugin, W));
    lines.push("║" + " ".repeat(W) + "║");
  }

  lines.push("╚" + "═".repeat(W) + "╝");

  return lines.join("\n");
}

function formatPluginSection(plugin: PluginReport, W: number): string[] {
  const lines: string[] = [];
  const name = plugin.pluginName ?? plugin.pluginId;
  const header = `  ${name}${" ".repeat(Math.max(1, 30 - name.length))}installed ${plugin.installedDays}d`;

  lines.push("║" + pad(header, W) + "║");

  const tf = plugin.triggerFrequency;
  lines.push(
    "║" +
      pad(`  ├─ Triggered: ${tf.totalTriggers} times (${tf.triggersPerDay}/day)`, W) +
      "║"
  );

  const td = plugin.tokenDelta;
  const sign = td.deltaPercent >= 0 ? "+" : "";
  lines.push(
    "║" +
      pad(
        `  ├─ Token overhead: ${sign}${td.deltaPercent}% (~$${td.estimatedMonthlyCostUSD}/mo)`,
        W
      ) +
      "║"
  );

  const ct = plugin.conversationTurns;
  if (ct.avgTurnsWithPlugin > 0 || ct.avgTurnsWithoutPlugin > 0) {
    const arrow = ct.deltaPercent < 0 ? "▼" : ct.deltaPercent > 0 ? "▲" : "─";
    lines.push(
      "║" +
        pad(
          `  ├─ Avg turns/session: ${ct.avgTurnsWithoutPlugin} → ${ct.avgTurnsWithPlugin} (${arrow}${Math.abs(ct.deltaPercent)}%)`,
          W
        ) +
        "║"
    );
  }

  const is = plugin.implicitSatisfaction;
  if (is.totalSignals > 0) {
    lines.push(
      "║" +
        pad(`  ├─ User acceptance rate: ${is.acceptanceRate}%`, W) +
        "║"
    );
    if (is.retryRate > 0) {
      lines.push(
        "║" +
          pad(`  ├─ Retry rate after trigger: ${is.retryRate}%`, W) +
          "║"
      );
    }
  }

  if (plugin.llmJudge && plugin.llmJudge.sampleCount > 0) {
    const lj = plugin.llmJudge;
    lines.push(
      "║" +
        pad(
          `  ├─ LLM Judge score: ${lj.avgScoreWithPlugin}/5 (vs ${lj.avgScoreWithoutPlugin} baseline)`,
          W
        ) +
        "║"
    );
  }

  const icon = VERDICT_ICONS[plugin.verdict.level];
  lines.push(
    "║" +
      pad(`  └─ Verdict: ${icon} ${plugin.verdict.label}`, W) +
      "║"
  );

  return lines;
}

function center(text: string, width: number): string {
  const len = visualLength(text);
  if (len >= width) return text.slice(0, width);
  const left = Math.floor((width - len) / 2);
  const right = width - len - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function pad(text: string, width: number): string {
  const len = visualLength(text);
  if (len >= width) return text.slice(0, width);
  return text + " ".repeat(width - len);
}

/** Account for emoji/wide chars in visual width (simplified) */
function visualLength(text: string): number {
  // Simple approximation: count emoji as 2 chars
  let len = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff || (code >= 0x2600 && code <= 0x27bf)) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

/** Format a single plugin report for compact inline display */
export function formatPluginSummary(plugin: PluginReport): string {
  const name = plugin.pluginName ?? plugin.pluginId;
  const tf = plugin.triggerFrequency;
  const td = plugin.tokenDelta;
  const is = plugin.implicitSatisfaction;
  const icon = VERDICT_ICONS[plugin.verdict.level];

  return [
    `${icon} ${name} (installed ${plugin.installedDays}d)`,
    `  Triggers: ${tf.totalTriggers} (${tf.triggersPerDay}/day)`,
    `  Token overhead: ${td.deltaPercent >= 0 ? "+" : ""}${td.deltaPercent}% (~$${td.estimatedMonthlyCostUSD}/mo)`,
    is.totalSignals > 0 ? `  Acceptance: ${is.acceptanceRate}%` : null,
    `  Verdict: ${plugin.verdict.label}`,
  ]
    .filter(Boolean)
    .join("\n");
}
