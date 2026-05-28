import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalPaperAutomationLoop } from "./openclaw-capital-paper-automation-loop.mjs";

function defaultRiskConfigPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json");
}

function defaultOutputDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading");
}

function defaultBurstReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-burst-latest.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function bool(value) {
  return value === true;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new Error(
      `Invalid ${label} JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function burstStopReason(loopReport, cycleIndex, maxCycles) {
  if (cycleIndex + 1 >= maxCycles) {
    return "max_cycles_reached";
  }
  if (loopReport.status !== "paper_intent_created") {
    return `stopped_on_${loopReport.status}`;
  }
  if (loopReport.readiness?.ready !== true) {
    return "stopped_on_readiness_not_ready";
  }
  if (loopReport.trading?.paperIntentCreated !== true) {
    return "stopped_without_paper_intent";
  }
  return "";
}

export async function runCapitalPaperHftBurst(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const riskConfigPath = path.resolve(options.riskConfigPath || defaultRiskConfigPath(repoRoot));
  const outputDir = path.resolve(options.outputDir || defaultOutputDir(repoRoot));
  const reportPath = path.resolve(options.reportPath || defaultBurstReportPath(repoRoot));
  const streamPath = path.join(path.dirname(reportPath), "capital-paper-hft-bursts.jsonl");
  const riskControls = await readJson(riskConfigPath, "Capital paper HFT risk controls");
  const riskIntervalMs = Math.max(
    100,
    Math.floor(numberOr(riskControls.decisionLoopIntervalMs, 250)),
  );
  const intervalMs = Math.max(
    riskIntervalMs,
    Math.floor(numberOr(options.intervalMs, riskIntervalMs)),
  );
  const maxCycles = Math.max(1, Math.min(100, Math.floor(numberOr(options.maxCycles, 5))));
  const maxDurationMs = Math.max(
    intervalMs,
    Math.floor(numberOr(options.maxDurationMs, Math.max(5_000, intervalMs * maxCycles))),
  );
  const startedAtMs = Date.now();
  const cycles = [];
  let stopReason = "not_started";

  for (let index = 0; index < maxCycles; index += 1) {
    if (Date.now() - startedAtMs > maxDurationMs) {
      stopReason = "max_duration_reached";
      break;
    }
    const { report } = await runCapitalPaperAutomationLoop({
      repoRoot,
      stateDir: options.stateDir || undefined,
      riskConfigPath,
      outputDir,
      maxQuoteAgeSeconds: options.maxQuoteAgeSeconds,
    });
    cycles.push({
      index,
      generatedAt: report.generatedAt,
      status: report.status,
      pumpStatus: report.pump.status,
      readinessStatus: report.readiness.status,
      quoteAgeSeconds: report.readiness.quoteAgeSeconds,
      paperIntentCreated: bool(report.trading.paperIntentCreated),
      paperIntentId: report.trading.paperIntentId,
      learningStatus: report.learning.status,
    });
    stopReason = burstStopReason(report, index, maxCycles);
    if (stopReason) {
      break;
    }
    await sleep(intervalMs);
  }

  const paperIntents = cycles.filter((cycle) => cycle.paperIntentCreated).length;
  const latestCycle = cycles.at(-1) ?? {};
  const finishedAtMs = Date.now();
  const burstReport = {
    schema: "openclaw.capital.paper-hft-burst.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status:
      paperIntents > 0
        ? "paper_burst_completed"
        : latestCycle.status
          ? `blocked_${latestCycle.status}`
          : "blocked_no_cycles",
    stopReason,
    summary: {
      intervalMs,
      riskIntervalMs,
      maxCycles,
      maxDurationMs,
      elapsedMs: finishedAtMs - startedAtMs,
      cyclesExecuted: cycles.length,
      paperIntents,
      latestStatus: latestCycle.status ?? "",
      latestPumpStatus: latestCycle.pumpStatus ?? "",
      latestQuoteAgeSeconds: latestCycle.quoteAgeSeconds ?? -1,
      latestLearningStatus: latestCycle.learningStatus ?? "",
    },
    risk: {
      mode: riskControls.mode,
      allowLiveTrading: riskControls.allowLiveTrading,
      writeBrokerOrders: riskControls.writeBrokerOrders,
      maxDecisionQuoteAgeSeconds: riskControls.maxDecisionQuoteAgeSeconds,
      maxPaperIntentsPerSecond: riskControls.maxPaperIntentsPerSecond,
      maxPaperIntentsPerMinute: riskControls.maxPaperIntentsPerMinute,
      maxPositionContracts: riskControls.maxPositionContracts,
    },
    cycles,
    files: {
      reportPath,
      streamPath,
      riskConfigPath,
      outputDir,
    },
    nextSafeTask:
      paperIntents > 0
        ? "觀察 paper intents 與 learning registry；仍不得啟用真實下單。"
        : "等待 fresh SKQuoteLib bid/ask quote callback 後重跑 capital-hft:paper-hft:burst。",
  };
  await writeJsonWithSha(reportPath, burstReport);
  await appendJsonLine(streamPath, burstReport);
  return burstReport;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    riskConfigPath: "",
    outputDir: "",
    reportPath: "",
    intervalMs: undefined,
    maxCycles: undefined,
    maxDurationMs: undefined,
    maxQuoteAgeSeconds: undefined,
    json: false,
    requireIntent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--state-dir") {
      options.stateDir = argv[++index] ?? options.stateDir;
    } else if (arg.startsWith("--state-dir=")) {
      options.stateDir = arg.slice("--state-dir=".length);
    } else if (arg === "--risk-config") {
      options.riskConfigPath = argv[++index] ?? options.riskConfigPath;
    } else if (arg.startsWith("--risk-config=")) {
      options.riskConfigPath = arg.slice("--risk-config=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index] ?? options.outputDir;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--report") {
      options.reportPath = argv[++index] ?? options.reportPath;
    } else if (arg.startsWith("--report=")) {
      options.reportPath = arg.slice("--report=".length);
    } else if (arg === "--interval-ms") {
      options.intervalMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = Number(arg.slice("--interval-ms=".length));
    } else if (arg === "--max-cycles") {
      options.maxCycles = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-cycles=")) {
      options.maxCycles = Number(arg.slice("--max-cycles=".length));
    } else if (arg === "--max-duration-ms") {
      options.maxDurationMs = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-duration-ms=")) {
      options.maxDurationMs = Number(arg.slice("--max-duration-ms=".length));
    } else if (arg === "--max-quote-age-seconds") {
      options.maxQuoteAgeSeconds = Number(argv[++index] ?? "");
    } else if (arg.startsWith("--max-quote-age-seconds=")) {
      options.maxQuoteAgeSeconds = Number(arg.slice("--max-quote-age-seconds=".length));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-intent") {
      options.requireIntent = true;
    }
  }
  return options;
}

function formatSummary(report) {
  return [
    "OpenClaw Capital paper HFT burst",
    `status=${report.status}`,
    `cycles=${report.summary.cyclesExecuted}`,
    `paperIntents=${report.summary.paperIntents}`,
    `latestPump=${report.summary.latestPumpStatus || "none"}`,
    `latestQuoteAgeSeconds=${report.summary.latestQuoteAgeSeconds}`,
    `stopReason=${report.stopReason}`,
    `report=${report.files.reportPath}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalPaperHftBurst(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(report)}\n`);
  }
  if (options.requireIntent && report.summary.paperIntents <= 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital paper HFT burst failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
