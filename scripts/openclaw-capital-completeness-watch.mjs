#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.completeness-watch.v1";
const DEFAULT_INTERVAL_MS = 300000;
const DEFAULT_STATE_DIR = path.join(process.cwd(), "reports", "hermes-agent", "state");
const LATEST_FILE = "openclaw-capital-completeness-watch-latest.json";
const RUNS_FILE = "openclaw-capital-completeness-watch-runs.jsonl";

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseArgs(argv) {
  const options = {
    intervalMs: DEFAULT_INTERVAL_MS,
    maxCycles: 0,
    once: false,
    json: false,
    stateDir: DEFAULT_STATE_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--interval-ms") {
      options.intervalMs = numberOr(argv[++index], options.intervalMs);
      continue;
    }
    if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = numberOr(arg.slice("--interval-ms=".length), options.intervalMs);
      continue;
    }
    if (arg === "--max-cycles") {
      options.maxCycles = numberOr(argv[++index], options.maxCycles);
      continue;
    }
    if (arg.startsWith("--max-cycles=")) {
      options.maxCycles = numberOr(arg.slice("--max-cycles=".length), options.maxCycles);
      continue;
    }
    if (arg === "--state-dir") {
      options.stateDir = path.resolve(argv[++index] ?? options.stateDir);
      continue;
    }
    if (arg.startsWith("--state-dir=")) {
      options.stateDir = path.resolve(arg.slice("--state-dir=".length));
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
  }

  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1000) {
    options.intervalMs = DEFAULT_INTERVAL_MS;
  }
  if (!Number.isFinite(options.maxCycles) || options.maxCycles < 0) {
    options.maxCycles = 0;
  }
  if (options.once) {
    options.maxCycles = 1;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: typeof exitCode === "number" ? exitCode : 1,
        stdout,
        stderr,
      });
    });
    child.on("error", (error) => {
      resolve({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function parseCheckOutput(stdout) {
  const parsed = {
    status: "",
    paperStrategyReady: null,
    liveTradingReady: null,
    unfinished: null,
    nextSafeTask: "",
  };
  const lines = String(stdout).split(/\r?\n/u);
  for (const line of lines) {
    if (line.startsWith("status=")) {
      parsed.status = line.slice("status=".length).trim();
      continue;
    }
    if (line.startsWith("paperStrategyReady=")) {
      const value = line.slice("paperStrategyReady=".length).trim();
      parsed.paperStrategyReady = value === "true" ? true : value === "false" ? false : null;
      continue;
    }
    if (line.startsWith("liveTradingReady=")) {
      const value = line.slice("liveTradingReady=".length).trim();
      parsed.liveTradingReady = value === "true" ? true : value === "false" ? false : null;
      continue;
    }
    if (line.startsWith("unfinished=")) {
      const value = Number(line.slice("unfinished=".length).trim());
      parsed.unfinished = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith("nextSafeTask=")) {
      parsed.nextSafeTask = line.slice("nextSafeTask=".length).trim();
    }
  }
  return parsed;
}

function buildBlockerSummary(record) {
  const status = record.parsed.status || "unknown";
  const unfinished = Number.isFinite(Number(record.parsed.unfinished))
    ? Number(record.parsed.unfinished)
    : "null";
  if (record.success) {
    return `ok status=${status} unfinished=${unfinished}`;
  }
  const nextSafeTask = record.parsed.nextSafeTask || "n/a";
  return `fail exitCode=${record.exitCode} status=${status} nextSafeTask=${nextSafeTask}`;
}

export async function runCapitalCompletenessWatchCycle(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const checkScript = path.join(repoRoot, "scripts", "check-capital-completeness-report.mjs");
  const result = await runCommand(process.execPath, [checkScript], repoRoot);
  const parsed = parseCheckOutput(result.stdout);
  const success = result.exitCode === 0;
  return {
    command: `node ${path.relative(repoRoot, checkScript).split(path.sep).join("/")}`,
    ...result,
    success,
    parsed,
  };
}

export async function runCapitalCompletenessWatch(options = {}) {
  const parsedOptions = parseArgs(options.argv ?? process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const latestPath = path.join(parsedOptions.stateDir, LATEST_FILE);
  const runsPath = path.join(parsedOptions.stateDir, RUNS_FILE);
  const previousLatest = await readJsonOptional(latestPath);
  let consecutiveFailureCount = Number.isInteger(previousLatest?.consecutiveFailureCount)
    ? previousLatest.consecutiveFailureCount
    : 0;
  let lastSuccessAt =
    typeof previousLatest?.lastSuccessAt === "string" &&
    previousLatest.lastSuccessAt.trim().length > 0
      ? previousLatest.lastSuccessAt
      : null;
  const maxCycles =
    parsedOptions.maxCycles === 0 ? Number.POSITIVE_INFINITY : parsedOptions.maxCycles;
  const cycles = [];
  let cycleIndex = 0;

  while (cycleIndex < maxCycles) {
    cycleIndex += 1;
    const cycle = await runCapitalCompletenessWatchCycle({ repoRoot });
    const record = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      cycle: cycleIndex,
      mode: parsedOptions.once ? "once" : "watch",
      intervalMs: parsedOptions.intervalMs,
      readOnly: true,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      ...cycle,
    };
    cycles.push(record);
    if (record.success) {
      consecutiveFailureCount = 0;
      lastSuccessAt = record.finishedAt || record.generatedAt;
    } else {
      consecutiveFailureCount += 1;
    }

    const latest = {
      schema: SCHEMA,
      generatedAt: record.generatedAt,
      mode: record.mode,
      cycle: record.cycle,
      readOnly: true,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      status: record.parsed.status || "unknown",
      paperStrategyReady: record.parsed.paperStrategyReady,
      liveTradingReady: record.parsed.liveTradingReady,
      unfinished: record.parsed.unfinished,
      nextSafeTask: record.parsed.nextSafeTask || "",
      command: record.command,
      exitCode: record.exitCode,
      success: record.success,
      durationMs: record.durationMs,
      blockerSummary: buildBlockerSummary(record),
      lastSuccessAt,
      consecutiveFailureCount,
      reportPath: path.relative(repoRoot, latestPath).split(path.sep).join("/"),
      runsPath: path.relative(repoRoot, runsPath).split(path.sep).join("/"),
    };

    await writeJsonWithSha(latestPath, latest);
    await appendJsonLine(runsPath, record);

    if (parsedOptions.once || cycleIndex >= maxCycles) {
      return { latest, cycles, latestPath, runsPath };
    }
    await sleep(parsedOptions.intervalMs);
  }

  return {
    latest: cycles[cycles.length - 1] ?? null,
    cycles,
    latestPath,
    runsPath,
  };
}

async function main() {
  const result = await runCapitalCompletenessWatch();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result.latest, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital completeness watch",
      `status=${result.latest?.status ?? "unknown"}`,
      `paperStrategyReady=${result.latest?.paperStrategyReady}`,
      `liveTradingReady=${result.latest?.liveTradingReady}`,
      `unfinished=${result.latest?.unfinished}`,
      `success=${result.latest?.success}`,
      `blockerSummary=${result.latest?.blockerSummary ?? ""}`,
      `stateFile=${result.latestPath}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `openclaw capital completeness watch failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
