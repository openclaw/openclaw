import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalPaperHftBurst } from "./openclaw-capital-paper-hft-burst.mjs";
import { readCapitalQuoteState } from "./openclaw-capital-quote-reader.mjs";

function defaultRiskConfigPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json");
}

function defaultStrategyPath(repoRoot) {
  return path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json");
}

function defaultOutputDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading");
}

function defaultTriggerStatePath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-trigger-state.json");
}

function defaultTriggerReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-trigger-latest.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function arrayOr(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw new Error(
      `Invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
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

function quoteIdentity(readerState) {
  const quote = readerState?.quote ?? {};
  const hash = readerState?.files?.latestQuoteEventSha256 ?? "";
  const parts = [
    hash,
    quote.receivedAt ?? "",
    quote.eventSource ?? "",
    quote.stockNo ?? "",
    quote.bid ?? "",
    quote.ask ?? "",
    quote.close ?? "",
    quote.qty ?? "",
  ];
  return sha256Text(parts.join("|"));
}

function quoteIsActionable(readerState, maxQuoteAgeSeconds) {
  const quote = readerState?.quote ?? {};
  const ageSeconds = numberOr(readerState?.quoteEventAgeSeconds, Number.POSITIVE_INFINITY);
  const bid = numberOr(quote.bid, 0);
  const ask = numberOr(quote.ask, 0);
  const fresh = Number.isFinite(ageSeconds) && ageSeconds <= maxQuoteAgeSeconds;
  const bidAskUsable = bid > 0 && ask > 0 && ask >= bid;
  return {
    actionable: readerState?.ready === true && fresh && bidAskUsable,
    fresh,
    bidAskUsable,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : -1,
    bid,
    ask,
  };
}

function buildBaseReport({ readerState, previousState, identity, actionability, riskControls }) {
  return {
    schema: "openclaw.capital.paper-hft-trigger.v1",
    generatedAt: new Date().toISOString(),
    provider: "capital",
    mode: "paper",
    readOnlyQuoteOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    hftLikeAutomation: true,
    status: "pending",
    quote: {
      identity,
      isNew: identity !== previousState?.lastHandledQuoteIdentity,
      stockNo: readerState?.quote?.stockNo ?? "",
      stockName: readerState?.quote?.stockName ?? "",
      eventSource: readerState?.quote?.eventSource ?? "",
      receivedAt: readerState?.quote?.receivedAt ?? "",
      ageSeconds: actionability.ageSeconds,
      fresh: actionability.fresh,
      bidAskUsable: actionability.bidAskUsable,
      bid: readerState?.quote?.bid ?? "",
      ask: readerState?.quote?.ask ?? "",
      close: readerState?.quote?.close ?? "",
      qty: readerState?.quote?.qty ?? "",
    },
    risk: {
      maxDecisionQuoteAgeSeconds: riskControls.maxDecisionQuoteAgeSeconds,
      decisionLoopIntervalMs: riskControls.decisionLoopIntervalMs,
      allowLiveTrading: riskControls.allowLiveTrading,
      writeBrokerOrders: riskControls.writeBrokerOrders,
    },
    burst: null,
    previous: {
      lastHandledQuoteIdentity: previousState?.lastHandledQuoteIdentity ?? "",
      lastStatus: previousState?.lastStatus ?? "",
      lastHandledAt: previousState?.lastHandledAt ?? "",
    },
  };
}

export async function runCapitalPaperHftTrigger(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const outputDir = path.resolve(options.outputDir || defaultOutputDir(repoRoot));
  const riskConfigPath = path.resolve(options.riskConfigPath || defaultRiskConfigPath(repoRoot));
  const strategyPath = path.resolve(options.strategyPath || defaultStrategyPath(repoRoot));
  const statePath = path.resolve(options.statePath || defaultTriggerStatePath(repoRoot));
  const reportPath = path.resolve(options.reportPath || defaultTriggerReportPath(repoRoot));
  const streamPath = path.join(path.dirname(reportPath), "capital-paper-hft-triggers.jsonl");
  const [riskControls, previousState, strategy] = await Promise.all([
    readJson(riskConfigPath, {}),
    readJson(statePath, {}),
    readJson(strategyPath, {}),
  ]);
  const maxQuoteAgeSeconds = numberOr(
    options.maxQuoteAgeSeconds,
    riskControls.maxDecisionQuoteAgeSeconds ?? 2,
  );
  const readerState = await readCapitalQuoteState({
    stateDir: options.stateDir || undefined,
    targetStockNo: stringOr(strategy.targetStockNo, stringOr(strategy.symbol)),
    targetStockNos: arrayOr(strategy.targetStockNos),
    quoteAliases: arrayOr(strategy.quoteAliases),
    marketCode: stringOr(strategy.marketCode, stringOr(strategy.symbol)),
  });
  const identity = quoteIdentity(readerState);
  const actionability = quoteIsActionable(readerState, maxQuoteAgeSeconds);
  const report = buildBaseReport({
    readerState,
    previousState,
    identity,
    actionability,
    riskControls,
  });

  if (identity === previousState?.lastHandledQuoteIdentity) {
    report.status = "idle_duplicate_quote";
    report.reason = "Latest SKQuoteLib quote callback was already handled; burst skipped.";
    report.nextSafeTask = "等待下一筆新的 SKQuoteLib quote callback。";
  } else if (!actionability.actionable) {
    report.status = "blocked_quote_not_actionable";
    report.reason = "Quote callback is new but not fresh/actionable for HFT paper burst.";
    report.nextSafeTask = "等待 fresh 且 bid/ask 可用的新 SKQuoteLib quote callback。";
  } else {
    const burst = await runCapitalPaperHftBurst({
      repoRoot,
      stateDir: options.stateDir || undefined,
      riskConfigPath,
      outputDir,
      intervalMs: options.intervalMs,
      maxCycles: options.maxCycles,
      maxDurationMs: options.maxDurationMs,
      maxQuoteAgeSeconds,
    });
    report.status = "burst_executed";
    report.reason = "New actionable SKQuoteLib quote callback triggered paper HFT burst.";
    report.burst = {
      status: burst.status,
      stopReason: burst.stopReason,
      cyclesExecuted: burst.summary.cyclesExecuted,
      paperIntents: burst.summary.paperIntents,
      latestPumpStatus: burst.summary.latestPumpStatus,
      latestQuoteAgeSeconds: burst.summary.latestQuoteAgeSeconds,
      latestLearningStatus: burst.summary.latestLearningStatus,
      reportPath: burst.files.reportPath,
    };
    report.nextSafeTask =
      burst.summary.paperIntents > 0
        ? "觀察 paper intents 與 learning registry；仍不得啟用真實下單。"
        : "檢查 burst 阻擋原因；仍維持 paper-only。";
  }

  const nextState = {
    schema: "openclaw.capital.paper-hft-trigger-state.v1",
    updatedAt: new Date().toISOString(),
    lastHandledQuoteIdentity: identity,
    lastStatus: report.status,
    lastHandledAt: report.generatedAt,
    lastQuote: report.quote,
  };
  report.files = {
    statePath,
    reportPath,
    streamPath,
    riskConfigPath,
    strategyPath,
    outputDir,
  };
  await writeJsonWithSha(statePath, nextState);
  await writeJsonWithSha(reportPath, report);
  await appendJsonLine(streamPath, report);
  return report;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    stateDir: "",
    riskConfigPath: "",
    strategyPath: "",
    outputDir: "",
    statePath: "",
    reportPath: "",
    intervalMs: undefined,
    maxCycles: undefined,
    maxDurationMs: undefined,
    maxQuoteAgeSeconds: undefined,
    json: false,
    requireBurst: false,
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
    } else if (arg === "--strategy") {
      options.strategyPath = argv[++index] ?? options.strategyPath;
    } else if (arg.startsWith("--strategy=")) {
      options.strategyPath = arg.slice("--strategy=".length);
    } else if (arg === "--output-dir") {
      options.outputDir = argv[++index] ?? options.outputDir;
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--state") {
      options.statePath = argv[++index] ?? options.statePath;
    } else if (arg.startsWith("--state=")) {
      options.statePath = arg.slice("--state=".length);
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
    } else if (arg === "--require-burst") {
      options.requireBurst = true;
    }
  }
  return options;
}

function formatSummary(report) {
  return [
    "OpenClaw Capital paper HFT trigger",
    `status=${report.status}`,
    `isNew=${report.quote.isNew}`,
    `ageSeconds=${report.quote.ageSeconds}`,
    `bidAskUsable=${report.quote.bidAskUsable}`,
    `burst=${report.burst?.status ?? "none"}`,
    `report=${report.files.reportPath}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalPaperHftTrigger(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(report)}\n`);
  }
  if (options.requireBurst && report.status !== "burst_executed") {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital paper HFT trigger failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
