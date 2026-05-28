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
  "openclaw-tradingagents-auto-verify-latest.json",
);

const args = process.argv.slice(2);
const allowSimulated = args.includes("--allow-simulated");
const noStart = args.includes("--no-start");
const runtimeRetries = clampInt(valueAfter("--runtime-retries"), 3, 1, 10);
const runtimeRetryMs = clampInt(valueAfter("--runtime-retry-ms"), 3000, 500, 60000);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function clampInt(raw, fallback, min, max) {
  const num = Number.parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, num));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, commandArgs, timeoutMs = 0) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf-8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    maxBuffer: 10 * 1024 * 1024,
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

function runNodeCheck(name, script, scriptArgs = []) {
  const runResult = run(process.execPath, [script, ...scriptArgs], 180000);
  let report = null;
  let parseError = null;
  try {
    report = parseJson(runResult.stdout);
  } catch (error) {
    parseError = error.message;
  }
  const ok = runResult.exitCode === 0 && parseError === null;
  return {
    name,
    ok,
    exitCode: runResult.exitCode,
    parseError,
    error: runResult.error,
    stderr: runResult.stderr.trim(),
    report,
  };
}

function runStartStep() {
  const runResult = run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/tradingagents-bridge/start-all.ps1",
    ],
    300000,
  );
  return {
    name: "start",
    ok: runResult.exitCode === 0,
    exitCode: runResult.exitCode,
    error: runResult.error,
    stderr: runResult.stderr.trim(),
  };
}

const steps = [];
if (!noStart) {
  steps.push(runStartStep());
}

const integration = runNodeCheck(
  "integration",
  "scripts/check-openclaw-tradingagents-integration.mjs",
);
steps.push(integration);

let runtime = null;
for (let attempt = 1; attempt <= runtimeRetries; attempt += 1) {
  runtime = runNodeCheck("runtime", "scripts/check-openclaw-tradingagents-runtime.mjs", [
    "--allow-stopped",
  ]);
  runtime.attempt = attempt;
  if (runtime.report?.status === "ok" && runtime.ok) {
    break;
  }
  if (attempt < runtimeRetries) {
    await sleep(runtimeRetryMs);
  }
}
steps.push(runtime);

const upstream = runNodeCheck("upstream", "scripts/check-openclaw-tradingagents-upstream.mjs", [
  "--allow-blocked",
]);
steps.push(upstream);

const summary = runNodeCheck("summary", "scripts/check-openclaw-tradingagents-summary.mjs");
steps.push(summary);

const blockers = [];
const summaryStatus = summary.report?.status ?? "unknown";
const summaryAllowed = allowSimulated
  ? summaryStatus === "upstream_ready" || summaryStatus === "simulated_ready"
  : summaryStatus === "upstream_ready";

if (integration.report?.status !== "ok") {
  blockers.push("integration check is not ok");
}
if (runtime.report?.status !== "ok") {
  blockers.push("runtime check is not ok");
}
if (!allowSimulated && upstream.report?.status !== "pass") {
  blockers.push("upstream check is not pass");
}
if (!summaryAllowed) {
  blockers.push(`summary status is ${summaryStatus}`);
}

const report = {
  schema: "openclaw.tradingagents.auto-verify.v1",
  generatedAt: new Date().toISOString(),
  status: blockers.length === 0 ? "pass" : "blocked",
  mode: allowSimulated ? "allow_simulated" : "upstream_required",
  no_live_order_sent: true,
  brokerWriteAttempted: false,
  runtimeRetries,
  runtimeRetryMs,
  summaryStatus,
  remainingBlockers: blockers,
  checks: steps.map((step) => ({
    name: step.name,
    ok: step.ok,
    exitCode: step.exitCode,
    attempt: step.attempt ?? null,
    status: step.report?.status ?? null,
    error: step.error ?? step.parseError ?? null,
  })),
};

await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
await fs.writeFile(STATE_PATH, JSON.stringify(report, null, 2), "utf-8");
console.log(JSON.stringify(report, null, 2));

if (blockers.length > 0) {
  process.exitCode = 1;
}
