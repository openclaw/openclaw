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
  "openclaw-tradingagents-integration-latest.json",
);

const bridgePath = path.join(ROOT, "scripts", "tradingagents-bridge", "server.py");
const strategyPath = path.join(
  ROOT,
  "scripts",
  "strategy-engine",
  "strategies",
  "TradingAgentsStrategy.mjs",
);
const configPath = path.join(ROOT, "scripts", "strategy-engine", "config", "strategies.json");

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  const candidates = [
    { command: "python", args: [] },
    { command: "py", args: ["-3"] },
  ];
  for (const candidate of candidates) {
    const result = run(candidate.command, [...candidate.args, "--version"]);
    if (result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("self-test did not return JSON");
  }
  return JSON.parse(text.slice(start, end + 1));
}

const failures = [];
const checks = [];

for (const file of [bridgePath, strategyPath, configPath]) {
  const ok = await exists(file);
  checks.push({ name: "file_exists", file: path.relative(ROOT, file), ok });
  if (!ok) {
    failures.push(`missing ${path.relative(ROOT, file)}`);
  }
}

const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
const tradingAgentsStrategies = (config.strategies ?? []).filter(
  (strategy) => strategy.class === "TradingAgentsStrategy",
);
checks.push({
  name: "strategy_config",
  ok: tradingAgentsStrategies.length > 0,
  count: tradingAgentsStrategies.length,
});
if (tradingAgentsStrategies.length === 0) {
  failures.push("strategies.json has no TradingAgentsStrategy");
}

const nodeCheck = run(process.execPath, ["--check", strategyPath]);
checks.push({
  name: "node_check_strategy",
  ok: nodeCheck.status === 0,
  stderr: nodeCheck.stderr.trim(),
});
if (nodeCheck.status !== 0) {
  failures.push("node --check TradingAgentsStrategy failed");
}

const python = findPython();
if (!python) {
  checks.push({ name: "python_available", ok: false });
  failures.push("python or py -3 is unavailable");
} else {
  checks.push({ name: "python_available", ok: true, command: python.command });
  const selfTest = run(python.command, [...python.args, bridgePath, "--self-test", "--json"]);
  const ok = selfTest.status === 0;
  let parsed = null;
  let parseError = null;
  if (ok) {
    try {
      parsed = parseJsonOutput(selfTest.stdout);
    } catch (error) {
      parseError = error.message;
    }
  }
  const sample = parsed?.sampleSignal ?? {};
  const health = parsed?.health ?? {};
  const contractOk =
    ok &&
    parsed &&
    parsed.no_live_order_sent === true &&
    health.noOrderWrite === true &&
    health.brokerWriteAttempted === false &&
    sample.noOrderWrite === true &&
    sample.brokerWriteAttempted === false &&
    sample.mode === "paper_signal_only";
  checks.push({
    name: "bridge_self_test",
    ok: contractOk,
    exitCode: selfTest.status,
    parseError,
    healthStatus: health.status,
    sampleSignal: sample.signal,
    noLiveOrderSent: parsed?.no_live_order_sent,
  });
  if (!contractOk) {
    failures.push(
      `bridge self-test failed: ${parseError || selfTest.stderr.trim() || selfTest.stdout.trim()}`,
    );
  }
}

const report = {
  schema: "openclaw.tradingagents.integration.check.v1",
  generatedAt: new Date().toISOString(),
  status: failures.length === 0 ? "ok" : "blocked",
  checks,
  tradingAgentsStrategyCount: tradingAgentsStrategies.length,
  no_live_order_sent: true,
  remainingBlockers: failures,
};

await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
await fs.writeFile(STATE_PATH, JSON.stringify(report, null, 2), "utf-8");
console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
