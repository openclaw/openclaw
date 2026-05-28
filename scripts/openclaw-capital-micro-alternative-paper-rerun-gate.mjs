#!/usr/bin/env node
/**
 * Runs paper-only same-case simulations for lower-notional alternative Capital
 * intents, such as MCL/QM alternatives to CL/BZ. This never overwrites active
 * intents and never routes broker orders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.micro-alternative-paper-rerun-gate.v1";
const INTENT_SOURCE = "micro_alternative_paper_rerun_gate";
const DEFAULT_ALLOWED_SYMBOLS = new Set(["MCL0000", "QM0000"]);
const DEFAULT_MAX_RISK_NOTIONAL = 3000;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundNumber(value, decimals = 6) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

function toRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function marketGroupForSymbol(symbol, marketCode = "") {
  const code = String(marketCode || symbol)
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (["CL", "MCL", "QM", "BZ"].includes(code)) {
    return "energy";
  }
  if (["ES", "MES", "NQ", "MNQ", "YM", "MYM"].includes(code)) {
    return "us_equity_index";
  }
  if (["GC", "MGC", "SI", "SIL"].includes(code)) {
    return "metal";
  }
  if (["CD", "CAD"].includes(code)) {
    return "fx";
  }
  return code || "unknown";
}

function candidateAlternatives(intents, maxRiskNotional = DEFAULT_MAX_RISK_NOTIONAL) {
  return intents
    .filter((intent) => {
      const symbol = String(intent?.symbol ?? "").toUpperCase();
      const riskNotional = finiteNumber(intent?.riskNotional);
      return (
        DEFAULT_ALLOWED_SYMBOLS.has(symbol) &&
        intent?.paperOnly === true &&
        intent?.executionEligible === true &&
        intent?.routeReady === true &&
        intent?.historicalSnapshot !== true &&
        intent?.writeBrokerOrders !== true &&
        intent?.liveTradingEnabled !== true &&
        riskNotional !== null &&
        riskNotional > 0 &&
        riskNotional <= maxRiskNotional
      );
    })
    .toSorted((left, right) => {
      const leftRisk = finiteNumber(left?.riskNotional) ?? Number.POSITIVE_INFINITY;
      const rightRisk = finiteNumber(right?.riskNotional) ?? Number.POSITIVE_INFINITY;
      if (leftRisk !== rightRisk) {
        return leftRisk - rightRisk;
      }
      return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
    });
}

function cloneAlternativeIntent({ intent, generatedAt }) {
  const symbol = String(intent?.symbol ?? "").toUpperCase();
  const seed = [intent.intentId, symbol, intent.riskNotional, generatedAt].join("|");
  return {
    ...intent,
    intentId: `capital-micro-alternative-paper-${symbol.toLowerCase()}-${sha256Text(seed).slice(0, 16)}`,
    intentRunId: `capital-micro-alternative-paper-rerun-${sha256Text(generatedAt).slice(0, 16)}`,
    generatedAt,
    source: INTENT_SOURCE,
    paperOnly: true,
    executionEligible: true,
    resolverReady: true,
    routeReady: true,
    historicalSnapshot: false,
    promotionBlocked: false,
    paperExplorationOnly: false,
    allowLiveTrading: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    promoteLiveAuto: false,
    promoteLiveAutomatically: false,
    meta: {
      ...(intent.meta ?? {}),
      noLiveOrderSent: true,
      microAlternativeRerun: {
        schema: "openclaw.capital.micro-alternative-paper-intent.v1",
        sourceIntentId: intent.intentId ?? "",
        marketGroup: marketGroupForSymbol(symbol, intent.marketCode),
        reason: "lower_notional_alternative_for_tail_risk_same_case_rerun",
        noOrderWrite: true,
      },
    },
  };
}

function buildRerunSummary({ symbol, intentPath, simulationPath, simulation }) {
  const p05Pts = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_pts);
  const p05Notional = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_notional);
  const tailPass = p05Pts !== null && p05Pts > 0 && p05Notional !== null && p05Notional > 0;
  return {
    symbol,
    status: tailPass ? "micro_alternative_tail_passed" : "micro_alternative_tail_still_blocked",
    recommendation: String(simulation?.recommendation ?? ""),
    intentPath,
    simulationPath,
    totalIntents: finiteNumber(simulation?.stats?.total_intents),
    maxRiskNotional: finiteNumber(simulation?.stats?.max_risk_notional),
    expectedValuePts: finiteNumber(simulation?.stats?.expected_value_pts),
    p05TotalPnlPts: p05Pts,
    p05TotalPnlNotional: p05Notional,
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
  };
}

export async function buildMicroAlternativePaperRerunGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const currentIntentsPath =
    options.currentIntentsPath ??
    path.join(tradingRoot, "capital-current-paper-intents-from-target-registry.jsonl");
  const reportPath =
    options.reportPath ??
    path.join(stateRoot, "openclaw-capital-micro-alternative-paper-rerun-gate-latest.json");
  const panelPath =
    options.panelPath ?? path.join(tradingRoot, "capital-micro-alternative-paper-rerun-gate.json");
  const artifactDir =
    options.artifactDir ?? path.join(tradingRoot, "capital-micro-alternative-paper-rerun");
  const maxRiskNotional = finiteNumber(options.maxRiskNotional) ?? DEFAULT_MAX_RISK_NOTIONAL;
  const sourceText = await readTextIfExists(currentIntentsPath);
  const sourceIntents = sourceText ? parseJsonLines(sourceText) : [];
  const candidates = candidateAlternatives(sourceIntents, maxRiskNotional);
  const candidateRows = [];
  const reruns = [];
  const blockers = [];

  if (sourceIntents.length === 0) {
    blockers.push("current_paper_intents_missing");
  }
  if (candidates.length === 0) {
    blockers.push("micro_or_low_notional_alternative_missing");
  }

  const runToken = sha256Text(generatedAt).slice(0, 10);
  for (const candidate of candidates) {
    const symbol = String(candidate.symbol ?? "").toUpperCase();
    const alternativeIntent = cloneAlternativeIntent({ intent: candidate, generatedAt });
    const intentText = `${JSON.stringify(alternativeIntent)}\n`;
    const intentPath = path.join(
      artifactDir,
      `${symbol.toLowerCase()}-${runToken}-micro-alternative-intent.jsonl`,
    );
    const simulationPath = path.join(
      artifactDir,
      `${symbol.toLowerCase()}-${runToken}-micro-alternative-fill-simulation.json`,
    );
    await writeTextWithSha(intentPath, intentText);
    const simulation = await runStrategyFillSimulation({
      repoRoot,
      intentsPath: intentPath,
      outputPath: simulationPath,
      fallbackIntentsPath: intentPath,
      monteCarloIterations: options.monteCarloIterations ?? 500,
    });
    candidateRows.push({
      symbol,
      marketCode: String(candidate.marketCode ?? ""),
      marketGroup: marketGroupForSymbol(symbol, candidate.marketCode),
      sourceIntentId: candidate.intentId ?? "",
      alternativeIntentId: alternativeIntent.intentId,
      riskPts: finiteNumber(candidate.riskPts),
      rewardPts: finiteNumber(candidate.rewardPts),
      riskNotional: finiteNumber(candidate.riskNotional),
      rewardNotional: finiteNumber(candidate.rewardNotional),
      pointValue: finiteNumber(candidate.pointValue),
      pointValueCurrency: String(candidate.pointValueCurrency ?? ""),
      intentPath: toRepoPath(repoRoot, intentPath),
      simulationPath: toRepoPath(repoRoot, simulationPath),
      noOrderWrite: true,
    });
    reruns.push(
      buildRerunSummary({
        symbol,
        intentPath: toRepoPath(repoRoot, intentPath),
        simulationPath: toRepoPath(repoRoot, simulationPath),
        simulation,
      }),
    );
  }

  const passCount = reruns.filter(
    (rerun) => rerun.status === "micro_alternative_tail_passed",
  ).length;
  const status =
    blockers.length > 0 && reruns.length === 0
      ? "blocked_no_micro_alternative_ready"
      : passCount > 0
        ? "micro_alternative_candidate_tail_passed_requires_promotion_rerun"
        : reruns.length > 0
          ? "micro_alternative_rerun_completed_still_blocked"
          : "blocked_no_micro_alternative_ready";
  return {
    schema: SCHEMA,
    generatedAt,
    status,
    repoRoot,
    source: {
      currentIntentsPath: toRepoPath(repoRoot, currentIntentsPath),
      sourceIntentCount: sourceIntents.length,
      sourceIntentDigest: sourceText ? sha256Text(sourceText) : "",
      allowedSymbols: [...DEFAULT_ALLOWED_SYMBOLS].toSorted(),
      maxRiskNotional,
    },
    candidateCount: candidateRows.length,
    passCount,
    blockedCount: reruns.length - passCount,
    blockers,
    candidates: candidateRows,
    reruns,
    nextCommand:
      passCount > 0
        ? {
            command: "pnpm capital:strategy:fill-simulation:check",
            reason:
              "At least one micro alternative passed tail p05; rerun normal promotion gate before any operator packet.",
          }
        : {
            command: "pnpm capital:trade:current-paper-intents:check",
            reason:
              "Micro alternatives still failed p05; refresh quote digest and search for stronger low-notional candidates.",
          },
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    paths: {
      reportPath,
      panelPath,
      artifactDir,
    },
    machineLine: `microAlternativePaperRerun=${status};candidates=${candidateRows.map((candidate) => candidate.symbol).join("|") || "none"};pass=${passCount};blocked=${reruns.length - passCount};noOrderWrite=true`,
  };
}

export async function writeMicroAlternativePaperRerunGate(report) {
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    check: argv.includes("--check"),
    writeState: argv.includes("--write-state") || argv.includes("--check"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildMicroAlternativePaperRerunGate({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeMicroAlternativePaperRerunGate(report);
  }
  if (options.check) {
    if (
      report.safetyLock?.noLiveOrderSent !== true ||
      report.safetyLock?.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_MICRO_ALTERNATIVE_PAPER_RERUN_SAFETY_MISMATCH");
    }
    if (
      ![
        "micro_alternative_candidate_tail_passed_requires_promotion_rerun",
        "micro_alternative_rerun_completed_still_blocked",
        "blocked_no_micro_alternative_ready",
      ].includes(report.status)
    ) {
      throw new Error(`CAPITAL_MICRO_ALTERNATIVE_PAPER_RERUN_STATUS_INVALID=${report.status}`);
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
