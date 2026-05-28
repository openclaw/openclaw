#!/usr/bin/env node
/**
 * Runs paper-only same-case simulations for fresh Capital intents that pass a
 * high-confidence threshold. This isolates signal-strength blockers without
 * changing active intents or broker adapter state.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.high-confidence-paper-rerun-gate.v1";
const INTENT_SOURCE = "high_confidence_paper_rerun_gate";
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_CANDIDATES = 5;

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

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  return text ? JSON.parse(text) : null;
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

function requiredConfidenceValues(repairReport) {
  return [
    ...safeArray(repairReport?.selectedDiagnostics),
    ...safeArray(repairReport?.repairCandidatePlan?.topCurrentDiagnostics),
  ]
    .map((diagnostic) => finiteNumber(diagnostic?.requiredConfidenceForPositiveP05))
    .filter((value) => value !== null);
}

function confidenceGateSummary({ repairReport, minConfidence, sourceIntents, candidates }) {
  const requiredValues = requiredConfidenceValues(repairReport);
  const maxRequiredConfidence = requiredValues.length > 0 ? Math.max(...requiredValues) : null;
  const minRequiredConfidence = requiredValues.length > 0 ? Math.min(...requiredValues) : null;
  const requiredConfidenceStatus =
    maxRequiredConfidence !== null && maxRequiredConfidence > 1
      ? "impossible_under_current_signal_model"
      : maxRequiredConfidence !== null
        ? "reachable_if_signal_improves"
        : "not_reported";
  return {
    threshold: minConfidence,
    requiredConfidenceForPositiveP05: maxRequiredConfidence,
    minRequiredConfidenceForPositiveP05: minRequiredConfidence,
    requiredConfidenceStatus,
    sourceCandidateCount: sourceIntents.length,
    selectedCandidateCount: candidates.length,
  };
}

function highConfidenceCandidates(intents, minConfidence, maxCandidates) {
  return intents
    .filter((intent) => {
      const confidence = finiteNumber(intent?.confidence);
      const wallClockAgeSeconds = finiteNumber(intent?.sourceEvent?.wallClockAgeSeconds);
      const maxFreshSeconds = finiteNumber(intent?.sourceEvent?.maxFreshSeconds) ?? 300;
      return (
        confidence !== null &&
        confidence >= minConfidence &&
        intent?.paperOnly === true &&
        intent?.executionEligible === true &&
        intent?.routeReady === true &&
        intent?.historicalSnapshot !== true &&
        intent?.writeBrokerOrders !== true &&
        intent?.liveTradingEnabled !== true &&
        intent?.sourceEvent?.freshnessStatus === "fresh" &&
        wallClockAgeSeconds !== null &&
        wallClockAgeSeconds <= maxFreshSeconds
      );
    })
    .toSorted((left, right) => {
      const confidenceDelta =
        (finiteNumber(right?.confidence) ?? 0) - (finiteNumber(left?.confidence) ?? 0);
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }
      const leftRisk = finiteNumber(left?.riskNotional) ?? Number.POSITIVE_INFINITY;
      const rightRisk = finiteNumber(right?.riskNotional) ?? Number.POSITIVE_INFINITY;
      if (leftRisk !== rightRisk) {
        return leftRisk - rightRisk;
      }
      return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
    })
    .slice(0, maxCandidates);
}

function cloneHighConfidenceIntent({ intent, generatedAt, minConfidence }) {
  const symbol = String(intent?.symbol ?? "").toUpperCase();
  const seed = [intent.intentId, symbol, intent.confidence, generatedAt].join("|");
  return {
    ...intent,
    intentId: `capital-high-confidence-paper-${symbol.toLowerCase()}-${sha256Text(seed).slice(0, 16)}`,
    intentRunId: `capital-high-confidence-paper-rerun-${sha256Text(generatedAt).slice(0, 16)}`,
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
      highConfidenceRerun: {
        schema: "openclaw.capital.high-confidence-paper-intent.v1",
        sourceIntentId: intent.intentId ?? "",
        minConfidence,
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
    status: tailPass ? "high_confidence_tail_passed" : "high_confidence_tail_still_blocked",
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

export async function buildHighConfidencePaperRerunGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const minConfidence = finiteNumber(options.minConfidence) ?? DEFAULT_MIN_CONFIDENCE;
  const maxCandidates = Math.max(
    1,
    Math.floor(finiteNumber(options.maxCandidates) ?? DEFAULT_MAX_CANDIDATES),
  );
  const currentIntentsPath =
    options.currentIntentsPath ??
    path.join(tradingRoot, "capital-current-paper-intents-from-target-registry.jsonl");
  const repairReportPath =
    options.repairReportPath ??
    path.join(stateRoot, "openclaw-capital-strategy-tail-risk-repair-latest.json");
  const reportPath =
    options.reportPath ??
    path.join(stateRoot, "openclaw-capital-high-confidence-paper-rerun-gate-latest.json");
  const panelPath =
    options.panelPath ?? path.join(tradingRoot, "capital-high-confidence-paper-rerun-gate.json");
  const artifactDir =
    options.artifactDir ?? path.join(tradingRoot, "capital-high-confidence-paper-rerun");

  const sourceText = await readTextIfExists(currentIntentsPath);
  const sourceIntents = sourceText ? parseJsonLines(sourceText) : [];
  const repairReport = await readJsonIfExists(repairReportPath);
  const candidates = highConfidenceCandidates(sourceIntents, minConfidence, maxCandidates);
  const confidenceGate = confidenceGateSummary({
    repairReport,
    minConfidence,
    sourceIntents,
    candidates,
  });
  const candidateRows = [];
  const reruns = [];
  const blockers = [];

  if (sourceIntents.length === 0) {
    blockers.push("current_paper_intents_missing");
  }
  if (!repairReport) {
    blockers.push("tail_risk_repair_report_missing");
  }
  if (candidates.length === 0) {
    blockers.push("no_high_confidence_candidate");
  }
  if (confidenceGate.requiredConfidenceStatus === "impossible_under_current_signal_model") {
    blockers.push("required_confidence_above_one");
  }

  const runToken = sha256Text(generatedAt).slice(0, 10);
  for (const candidate of candidates) {
    const symbol = String(candidate.symbol ?? "").toUpperCase();
    const paperIntent = cloneHighConfidenceIntent({
      intent: candidate,
      generatedAt,
      minConfidence,
    });
    const intentText = `${JSON.stringify(paperIntent)}\n`;
    const intentPath = path.join(
      artifactDir,
      `${symbol.toLowerCase()}-${runToken}-high-confidence-intent.jsonl`,
    );
    const simulationPath = path.join(
      artifactDir,
      `${symbol.toLowerCase()}-${runToken}-high-confidence-fill-simulation.json`,
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
      sourceIntentId: candidate.intentId ?? "",
      highConfidenceIntentId: paperIntent.intentId,
      confidence: finiteNumber(candidate.confidence),
      minConfidence,
      riskPts: finiteNumber(candidate.riskPts),
      rewardPts: finiteNumber(candidate.rewardPts),
      riskNotional: finiteNumber(candidate.riskNotional),
      rewardNotional: finiteNumber(candidate.rewardNotional),
      pointValue: finiteNumber(candidate.pointValue),
      sourceFreshnessStatus: String(candidate.sourceEvent?.freshnessStatus ?? ""),
      sourceWallClockAgeSeconds: finiteNumber(candidate.sourceEvent?.wallClockAgeSeconds),
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

  const passCount = reruns.filter((rerun) => rerun.status === "high_confidence_tail_passed").length;
  const status =
    blockers.includes("no_high_confidence_candidate") && reruns.length === 0
      ? "blocked_no_high_confidence_candidate"
      : passCount > 0
        ? "high_confidence_candidate_tail_passed_requires_promotion_rerun"
        : reruns.length > 0
          ? "high_confidence_rerun_completed_still_blocked"
          : "blocked_no_high_confidence_candidate";
  return {
    schema: SCHEMA,
    generatedAt,
    status,
    repoRoot,
    source: {
      currentIntentsPath: toRepoPath(repoRoot, currentIntentsPath),
      repairReportPath: toRepoPath(repoRoot, repairReportPath),
      sourceIntentCount: sourceIntents.length,
      sourceIntentDigest: sourceText ? sha256Text(sourceText) : "",
      repairStatus: String(repairReport?.status ?? ""),
    },
    confidenceGate,
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
              "At least one high-confidence paper candidate passed tail p05; rerun normal promotion gate before any operator packet.",
          }
        : {
            command: "pnpm capital:trade:current-paper-intents:check",
            reason:
              "High-confidence paper candidates still failed p05; refresh quote digest and wait for stronger signal/outcome evidence.",
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
    machineLine: `highConfidencePaperRerun=${status};threshold=${minConfidence};requiredConfidence=${confidenceGate.requiredConfidenceForPositiveP05 ?? "none"};candidates=${candidateRows.map((candidate) => candidate.symbol).join("|") || "none"};pass=${passCount};blocked=${reruns.length - passCount};noOrderWrite=true`,
  };
}

export async function writeHighConfidencePaperRerunGate(report) {
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

function parseArgs(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    json: argv.includes("--json"),
    check: argv.includes("--check"),
    writeState: argv.includes("--write-state") || argv.includes("--check"),
    minConfidence: valueAfter("--min-confidence"),
    maxCandidates: valueAfter("--max-candidates"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildHighConfidencePaperRerunGate({
    repoRoot: process.cwd(),
    minConfidence: options.minConfidence,
    maxCandidates: options.maxCandidates,
  });
  if (options.writeState) {
    await writeHighConfidencePaperRerunGate(report);
  }
  if (options.check) {
    if (
      report.safetyLock?.noLiveOrderSent !== true ||
      report.safetyLock?.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_SAFETY_MISMATCH");
    }
    if (
      ![
        "high_confidence_candidate_tail_passed_requires_promotion_rerun",
        "high_confidence_rerun_completed_still_blocked",
        "blocked_no_high_confidence_candidate",
      ].includes(report.status)
    ) {
      throw new Error(`CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_STATUS_INVALID=${report.status}`);
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
