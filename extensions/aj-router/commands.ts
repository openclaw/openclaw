/**
 * `/router` command dispatcher. Single command with subcommands:
 *   - `/router stats` — 7-day summary from the routing log
 *   - `/router health` — show the alias map and whether each provider's
 *     auth env var is populated
 *   - `/router explain <prompt>` — dry-run the resolver without logging
 */

import type { RouterConfig } from "./config.js";
import { resolve, isRejection } from "./resolver.js";
import { lastNDaysWindow, loadSummary, type StatsSummary } from "./stats.js";

const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  ollama: ["OLLAMA_HOST"],
  lmstudio: ["LM_API_TOKEN"],
};

function providerIdFromRef(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(0, slash);
}

export type EnvReader = (name: string) => string | undefined;

function defaultEnvReader(name: string): string | undefined {
  return process.env[name];
}

function formatPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

function formatConfidence(n: number): string {
  return n.toFixed(2);
}

export function formatStats(summary: StatsSummary): string {
  if (summary.totalDecisions === 0) {
    return "AJ router — no routing decisions recorded in the last 7 days.";
  }
  const lines: string[] = [];
  lines.push("📊 AJ ROUTER — LAST 7 DAYS");
  lines.push("");
  lines.push(`Decisions: ${summary.totalDecisions}`);
  if (summary.rejected > 0) {
    lines.push(`Rejected:  ${summary.rejected}`);
  }
  lines.push("");
  lines.push("By alias:");
  for (const stat of summary.perAlias) {
    const pct = (stat.count / summary.totalDecisions) * 100;
    lines.push(`  ${stat.alias.padEnd(10)} ${String(stat.count).padStart(5)}  (${formatPct(pct)})`);
  }
  lines.push("");
  const escalationPct =
    summary.totalDecisions === 0 ? 0 : (summary.escalated / summary.totalDecisions) * 100;
  lines.push(`Escalations: ${summary.escalated} (${formatPct(escalationPct)})`);
  lines.push(`Avg confidence: ${formatConfidence(summary.averageConfidence)}`);
  return lines.join("\n");
}

export type FormatHealthParams = {
  config: RouterConfig;
  envReader?: EnvReader;
};

export function formatHealth(params: FormatHealthParams): string {
  const env = params.envReader ?? defaultEnvReader;
  const lines: string[] = [];
  lines.push("🦞 AJ ROUTER — HEALTH");
  lines.push("");
  lines.push("Alias map:");
  const rows: Array<[string, string, string]> = [];
  const aliasWidth = Math.max(...Object.keys(params.config.aliases).map((a) => a.length), 5);
  for (const [alias, ref] of Object.entries(params.config.aliases)) {
    const providerId = providerIdFromRef(ref);
    const envVars = PROVIDER_ENV_VARS[providerId] ?? [];
    const anySet = envVars.some((name) => {
      const v = env(name);
      return typeof v === "string" && v.length > 0;
    });
    const status = envVars.length === 0 ? "unknown" : anySet ? "ok" : "missing auth";
    rows.push([alias.padEnd(aliasWidth), ref, status]);
  }
  for (const [alias, ref, status] of rows) {
    lines.push(`  ${alias}  →  ${ref.padEnd(36)} [${status}]`);
  }
  lines.push("");
  lines.push(`Default alias: ${params.config.defaultAlias}`);
  lines.push(`Default sensitivity: ${params.config.defaultSensitivity}`);
  lines.push(`Escalation threshold: ${params.config.escalationThreshold.toFixed(2)}`);
  return lines.join("\n");
}

export type FormatExplainParams = {
  config: RouterConfig;
  prompt: string;
  sensitivity?: string;
};

export function formatExplain(params: FormatExplainParams): string {
  const result = resolve({
    config: params.config,
    prompt: params.prompt,
    sensitivity: params.sensitivity,
  });
  const lines: string[] = [];
  lines.push("🧭 AJ ROUTER — EXPLAIN");
  lines.push("");
  lines.push(`Prompt length: ${params.prompt.length}`);
  if (params.sensitivity) {
    lines.push(`Sensitivity:   ${params.sensitivity}`);
  }
  lines.push("");
  for (const step of result.trail) {
    lines.push(`  • ${step}`);
  }
  lines.push("");
  if (isRejection(result)) {
    lines.push(`REJECTED: ${result.reason}`);
  } else {
    lines.push(`→ ${result.alias}: ${result.modelRef}`);
  }
  return lines.join("\n");
}

export type DispatchParams = {
  config: RouterConfig;
  args: string;
  envReader?: EnvReader;
  statsLoader?: (logsDir: string) => Promise<StatsSummary>;
};

/** Dispatch `/router <sub> [args]` → rendered text response. */
export async function dispatch(params: DispatchParams): Promise<string> {
  const tokens = params.args.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  const rest = tokens.slice(1).join(" ");

  if (sub === "stats" || sub === "") {
    const loader =
      params.statsLoader ??
      (async (dir) => loadSummary({ logsDir: dir, window: lastNDaysWindow(7) }));
    const summary = await loader(params.config.logsDir);
    return formatStats(summary);
  }

  if (sub === "health") {
    return formatHealth({ config: params.config, envReader: params.envReader });
  }

  if (sub === "explain") {
    if (rest.length === 0) {
      return "Usage: /router explain <prompt>";
    }
    return formatExplain({ config: params.config, prompt: rest });
  }

  return `Unknown /router subcommand: '${sub}'. Try: stats | health | explain <prompt>`;
}
