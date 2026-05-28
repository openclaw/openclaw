#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const STATE_PATH = path.join(
  ROOT,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-tradingagents-summary-latest.json",
);

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error?.message ?? null,
  };
}

function parseJson(text) {
  const raw = String(text ?? "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object found");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function checked(name, script, args = []) {
  const run = runNode(script, args);
  try {
    return {
      name,
      ok: run.exitCode === 0,
      exitCode: run.exitCode,
      report: parseJson(run.stdout),
      stderr: run.stderr.trim(),
      error: run.error,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      exitCode: run.exitCode,
      report: null,
      stderr: run.stderr.trim(),
      error: error.message || run.error,
    };
  }
}

const integration = checked("integration", "scripts/check-openclaw-tradingagents-integration.mjs");
const runtime = checked("runtime", "scripts/check-openclaw-tradingagents-runtime.mjs", [
  "--allow-stopped",
]);
const upstream = checked("upstream", "scripts/check-openclaw-tradingagents-upstream.mjs", [
  "--allow-blocked",
]);

const runtimeHealth = runtime.report?.health ?? null;
const upstreamReady = upstream.report?.canStartUpstreamBridge === true;
const runtimeOk = runtime.report?.status === "ok";
const integrationOk = integration.report?.status === "ok";
const bridgeProvider = runtimeHealth?.provider ?? null;

const hardBlockers = [];
if (!integrationOk) {
  hardBlockers.push(...(integration.report?.remainingBlockers ?? ["integration check failed"]));
}
if (!runtimeOk) {
  hardBlockers.push(...(runtime.report?.remainingBlockers ?? ["runtime check failed"]));
}

const upstreamBlockers = upstream.report?.remainingBlockers ?? [];
const status = hardBlockers.length
  ? "blocked"
  : upstreamReady
    ? "upstream_ready"
    : "simulated_ready";

const report = {
  schema: "openclaw.tradingagents.summary.v1",
  generatedAt: new Date().toISOString(),
  status,
  integration: {
    status: integration.report?.status ?? "unknown",
    strategyCount: integration.report?.tradingAgentsStrategyCount ?? 0,
  },
  runtime: {
    status: runtime.report?.status ?? "unknown",
    host: runtime.report?.host ?? "127.0.0.1",
    port: runtime.report?.port ?? 8390,
    pid: runtime.report?.listener?.pid ?? null,
    provider: bridgeProvider,
    mode: runtimeHealth?.mode ?? null,
    noOrderWrite: runtimeHealth?.noOrderWrite === true,
    brokerWriteAttempted: runtimeHealth?.brokerWriteAttempted === true,
  },
  upstream: {
    status: upstream.report?.status ?? "unknown",
    ready: upstreamReady,
    vendorExists: upstream.report?.vendor?.exists === true,
    provider: upstream.report?.provider ?? null,
    model: upstream.report?.model ?? null,
    blockers: upstreamBlockers,
  },
  canAnalyzeNow: integrationOk && runtimeOk,
  canUseOfficialTradingAgents: upstreamReady,
  no_live_order_sent: true,
  brokerWriteAttempted: false,
  remainingBlockers: hardBlockers,
  nextSafeTask: upstreamReady
    ? "restart bridge with upstream TradingAgents provider via pnpm tradingagents:start"
    : "run pnpm tradingagents:install only after explicit human approval",
  checks: [integration, runtime, upstream].map((check) => ({
    name: check.name,
    ok: check.ok,
    exitCode: check.exitCode,
    error: check.error,
  })),
};

await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
await fs.writeFile(STATE_PATH, JSON.stringify(report, null, 2), "utf-8");
console.log(JSON.stringify(report, null, 2));

if (hardBlockers.length > 0) {
  process.exitCode = 1;
}
