#!/usr/bin/env node
/**
 * Runs a paper-only same-case rerun for the fresh cross-group candidate batch.
 * It never overwrites active intents and never sends or prepares broker orders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalFreshPaperCandidateCollector } from "./openclaw-capital-fresh-paper-candidate-collector.mjs";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.fresh-candidate-same-case-rerun-gate.v1";
const INTENT_SOURCE = "fresh_candidate_same_case_rerun_gate";

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    check: argv.includes("--check"),
    writeState: argv.includes("--write-state") || argv.includes("--check"),
  };
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
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

function parseJsonLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

function sourceIntentKey(intent) {
  return [
    String(intent?.intentId ?? ""),
    String(intent?.symbol ?? "").toUpperCase(),
    String(intent?.marketCode ?? "").toUpperCase(),
  ].join("|");
}

function sourceIntentByIdentity(sourceIntents) {
  const byIntentId = new Map();
  const bySymbol = new Map();
  for (const intent of sourceIntents) {
    const intentId = String(intent?.intentId ?? "");
    const symbol = String(intent?.symbol ?? "").toUpperCase();
    if (intentId) {
      byIntentId.set(intentId, intent);
    }
    if (symbol) {
      bySymbol.set(symbol, intent);
    }
  }
  return { byIntentId, bySymbol };
}

function cloneFreshCandidateIntent({ sourceIntent, selectedCandidate, generatedAt }) {
  const symbol = String(sourceIntent?.symbol ?? selectedCandidate?.symbol ?? "").toUpperCase();
  const seed = [sourceIntentKey(sourceIntent), generatedAt].join("|");
  return {
    ...sourceIntent,
    intentId: `capital-fresh-same-case-paper-${symbol.toLowerCase()}-${sha256Text(seed).slice(0, 16)}`,
    intentRunId: `capital-fresh-same-case-paper-rerun-${sha256Text(generatedAt).slice(0, 16)}`,
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
      ...(sourceIntent.meta ?? {}),
      noLiveOrderSent: true,
      freshCandidateSameCaseRerun: {
        schema: "openclaw.capital.fresh-candidate-same-case-paper-intent.v1",
        sourceIntentId: sourceIntent.intentId ?? "",
        sourceCandidateSymbol: selectedCandidate?.symbol ?? symbol,
        crossGroupProxy: selectedCandidate?.crossGroupProxy === true,
        oppositeExposure: selectedCandidate?.oppositeExposure === true,
        noOrderWrite: true,
      },
    },
  };
}

function buildRerunSummary({ intentPath, simulationPath, simulation }) {
  const p05Pts = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_pts);
  const p05Notional = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_notional);
  const repairReplay = simulation?.tailRiskRepair?.repairCandidateReplay ?? {};
  const tailPass = p05Pts !== null && p05Pts > 0 && p05Notional !== null && p05Notional > 0;
  return {
    status: tailPass
      ? "fresh_candidate_same_case_tail_passed"
      : "fresh_candidate_same_case_tail_still_blocked",
    recommendation: String(simulation?.recommendation ?? ""),
    intentPath,
    simulationPath,
    totalIntents: finiteNumber(simulation?.stats?.total_intents),
    maxRiskNotional: finiteNumber(simulation?.stats?.max_risk_notional),
    expectedValuePts: finiteNumber(simulation?.stats?.expected_value_pts),
    p05TotalPnlPts: p05Pts,
    p05TotalPnlNotional: p05Notional,
    stopHitRate: finiteNumber(simulation?.empiricalTailEvidence?.outcomeStats?.stopHitRate),
    repairReplayStatus: String(repairReplay?.status ?? ""),
    repairReplaySelectedSymbols: safeArray(repairReplay?.selectedSymbols),
    repairReplayMachineLine: String(repairReplay?.machineLine ?? ""),
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

export async function buildFreshCandidateSameCaseRerunGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const currentIntentsPath =
    options.currentIntentsPath ??
    path.join(tradingRoot, "capital-current-paper-intents-from-target-registry.jsonl");
  const reportPath =
    options.reportPath ??
    path.join(stateRoot, "openclaw-capital-fresh-candidate-same-case-rerun-gate-latest.json");
  const panelPath =
    options.panelPath ??
    path.join(tradingRoot, "capital-fresh-candidate-same-case-rerun-gate.json");
  const artifactDir =
    options.artifactDir ?? path.join(tradingRoot, "capital-fresh-candidate-same-case-rerun");
  const collectorReport =
    options.collectorReport ??
    (await runCapitalFreshPaperCandidateCollector({ repoRoot, writeState: true }));
  const selectedCandidates = safeArray(collectorReport?.selectedCandidates);
  const sourceText = await readTextIfExists(currentIntentsPath);
  const sourceIntents = sourceText ? parseJsonLines(sourceText) : [];
  const { byIntentId, bySymbol } = sourceIntentByIdentity(sourceIntents);
  const candidateRows = [];
  const rerunIntents = [];
  const blockers = [];

  if (sourceIntents.length === 0) {
    blockers.push("current_paper_intents_missing");
  }
  if (selectedCandidates.length === 0) {
    blockers.push("fresh_candidate_collector_selected_none");
  }
  if (collectorReport?.status !== "candidate_pool_ready_for_same_case_rerun") {
    blockers.push(`collector_status:${collectorReport?.status ?? "missing"}`);
  }

  for (const candidate of selectedCandidates) {
    const symbol = String(candidate?.symbol ?? "").toUpperCase();
    const sourceIntent =
      byIntentId.get(String(candidate?.intentId ?? "")) ?? bySymbol.get(symbol) ?? null;
    if (!sourceIntent) {
      blockers.push(`source_intent_missing:${symbol || "unknown"}`);
      continue;
    }
    const rerunIntent = cloneFreshCandidateIntent({
      sourceIntent,
      selectedCandidate: candidate,
      generatedAt,
    });
    rerunIntents.push(rerunIntent);
    candidateRows.push({
      symbol,
      sourceIntentId: sourceIntent.intentId ?? "",
      rerunIntentId: rerunIntent.intentId,
      marketCode: String(sourceIntent.marketCode ?? ""),
      marketGroup: String(candidate?.marketGroup ?? ""),
      direction: String(candidate?.direction ?? ""),
      confidence: finiteNumber(sourceIntent.confidence),
      riskNotional: finiteNumber(sourceIntent.riskNotional),
      rewardNotional: finiteNumber(sourceIntent.rewardNotional),
      crossGroupProxy: candidate?.crossGroupProxy === true,
      oppositeExposure: candidate?.oppositeExposure === true,
      freshResolved: candidate?.freshResolved === true,
      knownPointValue: candidate?.knownPointValue === true,
      noOrderWrite: true,
    });
  }

  const runToken = sha256Text(generatedAt).slice(0, 10);
  const intentPath = path.join(artifactDir, `${runToken}-fresh-candidate-batch.jsonl`);
  const simulationPath = path.join(artifactDir, `${runToken}-fresh-candidate-fill-simulation.json`);
  let rerun = null;
  if (rerunIntents.length > 0) {
    await writeTextWithSha(
      intentPath,
      rerunIntents.map((intent) => JSON.stringify(intent)).join("\n") + "\n",
    );
    const simulation = await runStrategyFillSimulation({
      repoRoot,
      intentsPath: intentPath,
      outputPath: simulationPath,
      fallbackIntentsPath: intentPath,
      monteCarloIterations: options.monteCarloIterations ?? 500,
    });
    rerun = buildRerunSummary({
      intentPath: toRepoPath(repoRoot, intentPath),
      simulationPath: toRepoPath(repoRoot, simulationPath),
      simulation,
    });
  }

  const passCount = rerun?.status === "fresh_candidate_same_case_tail_passed" ? 1 : 0;
  const status =
    rerunIntents.length === 0
      ? "blocked_no_fresh_candidate_batch"
      : passCount > 0
        ? "fresh_candidate_same_case_tail_passed_requires_promotion_rerun"
        : "fresh_candidate_same_case_rerun_completed_still_blocked";
  return {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status,
    source: {
      collectorStatus: collectorReport?.status ?? "missing",
      collectorReportPath: collectorReport?.paths?.reportPath ?? "",
      currentIntentsPath: toRepoPath(repoRoot, currentIntentsPath),
      sourceIntentCount: sourceIntents.length,
      sourceIntentDigest: sourceText ? sha256Text(sourceText) : "",
    },
    selectedCandidateCount: selectedCandidates.length,
    rerunIntentCount: rerunIntents.length,
    passCount,
    blockedCount: rerun ? 1 - passCount : 0,
    blockers,
    candidates: candidateRows,
    rerun,
    nextCommand:
      passCount > 0
        ? {
            command: "pnpm capital:strategy:fill-simulation:check",
            reason:
              "Fresh candidate batch passed tail p05; rerun the normal promotion gate before any operator packet.",
          }
        : {
            command: "pnpm capital:trade:current-paper-intents:check",
            reason:
              "Fresh candidate batch still failed tail p05; refresh quote digest or collect opposite exposure candidates.",
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
      intentPath,
      simulationPath,
    },
    machineLine: `freshCandidateSameCaseRerun=${status};selected=${candidateRows.map((candidate) => candidate.symbol).join("|") || "none"};pass=${passCount};p05=${rerun?.p05TotalPnlPts ?? "missing"};stopHitRate=${rerun?.stopHitRate ?? "missing"};noOrderWrite=true`,
  };
}

export async function writeFreshCandidateSameCaseRerunGate(report) {
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildFreshCandidateSameCaseRerunGate({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeFreshCandidateSameCaseRerunGate(report);
  }
  if (options.check) {
    if (
      report.safetyLock?.noLiveOrderSent !== true ||
      report.safetyLock?.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_FRESH_CANDIDATE_SAME_CASE_RERUN_SAFETY_MISMATCH");
    }
    if (
      ![
        "fresh_candidate_same_case_tail_passed_requires_promotion_rerun",
        "fresh_candidate_same_case_rerun_completed_still_blocked",
        "blocked_no_fresh_candidate_batch",
      ].includes(report.status)
    ) {
      throw new Error(`CAPITAL_FRESH_CANDIDATE_SAME_CASE_RERUN_STATUS_INVALID=${report.status}`);
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
