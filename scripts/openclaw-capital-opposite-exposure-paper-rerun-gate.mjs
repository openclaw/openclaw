#!/usr/bin/env node
/**
 * Runs a paper-only opposite-exposure rerun for the fresh candidate batch.
 * It only writes simulation artifacts and never sends or prepares broker orders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalFreshPaperCandidateCollector } from "./openclaw-capital-fresh-paper-candidate-collector.mjs";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.opposite-exposure-paper-rerun-gate.v1";
const INTENT_SOURCE = "opposite_exposure_paper_rerun_gate";

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

function normalizeExposure(sourceIntent, selectedCandidate) {
  const text = [
    sourceIntent?.direction,
    sourceIntent?.side,
    selectedCandidate?.direction,
    selectedCandidate?.side,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  if (/\b(short|sell)\b/u.test(text)) {
    return "short";
  }
  return "long";
}

function oppositeExposure(exposure) {
  return exposure === "short" ? "long" : "short";
}

function sideForExposure(exposure) {
  return exposure === "short" ? "sell" : "buy";
}

function priceDecimalsForIntent(intent, riskPts) {
  const configured = finiteNumber(intent?.meta?.contractRisk?.priceDecimals);
  if (configured !== null && configured >= 0 && configured <= 8) {
    return configured;
  }
  return riskPts < 1 ? 6 : 3;
}

function roundPrice(value, decimals) {
  return Number(value.toFixed(decimals));
}

function oppositePriceLevels(sourceIntent, exposure) {
  const entryPrice = finiteNumber(sourceIntent?.entryPrice ?? sourceIntent?.price);
  const riskPts = finiteNumber(sourceIntent?.riskPts) ?? 1;
  const rewardPts = finiteNumber(sourceIntent?.rewardPts) ?? 1;
  if (entryPrice === null) {
    return {};
  }
  const decimals = priceDecimalsForIntent(sourceIntent, riskPts);
  const stopPrice = exposure === "short" ? entryPrice + riskPts : entryPrice - riskPts;
  const targetPrice = exposure === "short" ? entryPrice - rewardPts : entryPrice + rewardPts;
  return {
    price: roundPrice(entryPrice, decimals),
    entryPrice: roundPrice(entryPrice, decimals),
    stopPrice: roundPrice(stopPrice, decimals),
    stopLoss: roundPrice(stopPrice, decimals),
    targetPrice: roundPrice(targetPrice, decimals),
    takeProfit: roundPrice(targetPrice, decimals),
  };
}

function cloneOppositeExposureIntent({ sourceIntent, selectedCandidate, generatedAt }) {
  const symbol = String(sourceIntent?.symbol ?? selectedCandidate?.symbol ?? "").toUpperCase();
  const originalExposure = normalizeExposure(sourceIntent, selectedCandidate);
  const rerunExposure = oppositeExposure(originalExposure);
  const seed = [sourceIntentKey(sourceIntent), rerunExposure, generatedAt].join("|");
  return {
    ...sourceIntent,
    ...oppositePriceLevels(sourceIntent, rerunExposure),
    intentId: `capital-opposite-exposure-paper-${symbol.toLowerCase()}-${sha256Text(seed).slice(
      0,
      16,
    )}`,
    intentRunId: `capital-opposite-exposure-paper-rerun-${sha256Text(generatedAt).slice(0, 16)}`,
    generatedAt,
    source: INTENT_SOURCE,
    side: sideForExposure(rerunExposure),
    direction: rerunExposure,
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
      oppositeExposureRerun: {
        schema: "openclaw.capital.opposite-exposure-paper-intent.v1",
        sourceIntentId: sourceIntent.intentId ?? "",
        sourceCandidateSymbol: selectedCandidate?.symbol ?? symbol,
        originalSide: sourceIntent.side ?? "",
        originalDirection: sourceIntent.direction ?? "",
        originalExposure,
        rerunSide: sideForExposure(rerunExposure),
        rerunDirection: rerunExposure,
        crossGroupProxy: selectedCandidate?.crossGroupProxy === true,
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
    status: tailPass ? "opposite_exposure_tail_passed" : "opposite_exposure_tail_still_blocked",
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

function riskReviewCandidateBySymbol(riskNotionalReviewPlan) {
  return new Map(
    safeArray(riskNotionalReviewPlan?.candidates).map((candidate) => [
      String(candidate?.symbol ?? "").toUpperCase(),
      candidate,
    ]),
  );
}

function buildOppositeRiskReview({
  repoRoot,
  repairReportPath,
  riskNotionalReviewPlan,
  candidateRows,
  rerun,
}) {
  const reviewBySymbol = riskReviewCandidateBySymbol(riskNotionalReviewPlan);
  const planMaxRiskNotional = finiteNumber(riskNotionalReviewPlan?.maxRiskNotional);
  const fallbackMaxRiskNotional = finiteNumber(rerun?.maxRiskNotional);
  const maxRiskNotional = planMaxRiskNotional ?? fallbackMaxRiskNotional;
  const candidates = candidateRows.map((candidate) => {
    const symbol = String(candidate.symbol ?? "").toUpperCase();
    const reviewCandidate = reviewBySymbol.get(symbol) ?? {};
    const riskNotional = finiteNumber(candidate.riskNotional);
    const candidateMaxRiskNotional =
      finiteNumber(reviewCandidate?.maxRiskNotional) ?? maxRiskNotional;
    const overMaxRisk =
      riskNotional !== null &&
      candidateMaxRiskNotional !== null &&
      riskNotional > candidateMaxRiskNotional;
    return {
      symbol,
      riskNotional,
      maxRiskNotional: candidateMaxRiskNotional,
      overMaxRisk,
      reviewAction: String(reviewCandidate?.reviewAction ?? ""),
      paperReviewRiskPts: finiteNumber(reviewCandidate?.paperReviewRiskPts),
      paperReviewRewardPts: finiteNumber(reviewCandidate?.paperReviewRewardPts),
      canAutoApply: reviewCandidate?.canAutoApply === true,
      noOrderWrite: true,
    };
  });
  const overMaxRiskCount = candidates.filter((candidate) => candidate.overMaxRisk === true).length;
  const actionableCandidateCount = candidates.filter(
    (candidate) =>
      candidate.overMaxRisk === true &&
      candidate.reviewAction === "paper_only_reduce_risk_pts_or_use_smaller_contract_then_rerun" &&
      candidate.canAutoApply === false,
  ).length;
  const planRequiresReview =
    riskNotionalReviewPlan?.status === "requires_paper_risk_resizing_review";
  const status =
    candidateRows.length === 0 || !rerun
      ? "blocked_no_rerun"
      : planRequiresReview || overMaxRiskCount > 0
        ? "requires_paper_risk_resizing_review"
        : "clear";
  const selected = candidates.map((candidate) => candidate.symbol).join("|") || "none";
  return {
    schema: "openclaw.capital.opposite-exposure-risk-review.v1",
    status,
    source: {
      repairReportPath: toRepoPath(repoRoot, repairReportPath),
      riskNotionalReviewStatus: String(riskNotionalReviewPlan?.status ?? ""),
      riskNotionalReviewMachineLine: String(riskNotionalReviewPlan?.machineLine ?? ""),
    },
    maxRiskNotional,
    candidateCount: candidates.length,
    overMaxRiskCount,
    actionableCandidateCount,
    candidates,
    requiredEvidence: [
      "riskNotional <= maxRiskNotional",
      "paper-only resized rerun p05_total_pnl_pts > 0",
      "paper-only resized rerun p05_total_pnl_notional > 0",
      "same no-order-write safety lock",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `oppositeRiskReview=${status};maxRiskNotional=${maxRiskNotional ?? "missing"};overMax=${overMaxRiskCount};actionable=${actionableCandidateCount};symbols=${selected};noOrderWrite=true`,
  };
}

function nextCommandForResult({ passCount, riskReview }) {
  if (passCount > 0) {
    return {
      command: "pnpm capital:strategy:fill-simulation:check",
      reason:
        "Opposite exposure paper rerun passed tail p05; rerun normal promotion gate before any operator packet.",
    };
  }
  if (
    riskReview?.status === "requires_paper_risk_resizing_review" &&
    riskReview?.actionableCandidateCount > 0
  ) {
    return {
      command: "pnpm capital:strategy:risk-resized-paper-rerun:check",
      reason:
        "Opposite exposure paper rerun failed with over-max risk notional; run paper-only risk resizing before refreshing quotes.",
    };
  }
  return {
    command: "pnpm capital:trade:current-paper-intents:check",
    reason:
      "Opposite exposure paper rerun still failed tail p05 without an actionable risk-resize candidate; refresh current paper intents and collect a new fresh batch.",
  };
}

export async function buildOppositeExposurePaperRerunGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const currentIntentsPath =
    options.currentIntentsPath ??
    path.join(tradingRoot, "capital-current-paper-intents-from-target-registry.jsonl");
  const repairReportPath =
    options.repairReportPath ??
    path.join(stateRoot, "openclaw-capital-strategy-tail-risk-repair-latest.json");
  const reportPath =
    options.reportPath ??
    path.join(stateRoot, "openclaw-capital-opposite-exposure-paper-rerun-gate-latest.json");
  const panelPath =
    options.panelPath ?? path.join(tradingRoot, "capital-opposite-exposure-paper-rerun-gate.json");
  const artifactDir =
    options.artifactDir ?? path.join(tradingRoot, "capital-opposite-exposure-paper-rerun");
  const collectorReport =
    options.collectorReport ??
    (await runCapitalFreshPaperCandidateCollector({ repoRoot, writeState: true }));
  const selectedCandidates = safeArray(collectorReport?.selectedCandidates);
  const sourceText = await readTextIfExists(currentIntentsPath);
  const sourceIntents = sourceText ? parseJsonLines(sourceText) : [];
  const repairReport = await readJsonIfExists(repairReportPath);
  const riskNotionalReviewPlan = repairReport?.repairCandidatePlan?.riskNotionalReviewPlan ?? {};
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
    const rerunIntent = cloneOppositeExposureIntent({
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
      originalSide: String(sourceIntent.side ?? ""),
      originalDirection: String(sourceIntent.direction ?? ""),
      side: String(rerunIntent.side ?? ""),
      direction: String(rerunIntent.direction ?? ""),
      entryPrice: finiteNumber(rerunIntent.entryPrice ?? rerunIntent.price),
      stopPrice: finiteNumber(rerunIntent.stopPrice ?? rerunIntent.stopLoss),
      targetPrice: finiteNumber(rerunIntent.targetPrice ?? rerunIntent.takeProfit),
      confidence: finiteNumber(sourceIntent.confidence),
      riskNotional: finiteNumber(sourceIntent.riskNotional),
      rewardNotional: finiteNumber(sourceIntent.rewardNotional),
      crossGroupProxy: candidate?.crossGroupProxy === true,
      oppositeExposure: true,
      freshResolved: candidate?.freshResolved === true,
      knownPointValue: candidate?.knownPointValue === true,
      noOrderWrite: true,
    });
  }

  const runToken = sha256Text(generatedAt).slice(0, 10);
  const intentPath = path.join(artifactDir, `${runToken}-opposite-exposure-batch.jsonl`);
  const simulationPath = path.join(
    artifactDir,
    `${runToken}-opposite-exposure-fill-simulation.json`,
  );
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

  const passCount = rerun?.status === "opposite_exposure_tail_passed" ? 1 : 0;
  const riskReview = buildOppositeRiskReview({
    repoRoot,
    repairReportPath,
    riskNotionalReviewPlan,
    candidateRows,
    rerun,
  });
  const status =
    rerunIntents.length === 0
      ? "blocked_no_opposite_exposure_batch"
      : passCount > 0
        ? "opposite_exposure_tail_passed_requires_promotion_rerun"
        : "opposite_exposure_rerun_completed_still_blocked";
  return {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status,
    source: {
      collectorStatus: collectorReport?.status ?? "missing",
      collectorReportPath: collectorReport?.paths?.reportPath ?? "",
      currentIntentsPath: toRepoPath(repoRoot, currentIntentsPath),
      repairReportPath: toRepoPath(repoRoot, repairReportPath),
      sourceIntentCount: sourceIntents.length,
      sourceIntentDigest: sourceText ? sha256Text(sourceText) : "",
      riskNotionalReviewStatus: String(riskNotionalReviewPlan?.status ?? ""),
    },
    selectedCandidateCount: selectedCandidates.length,
    rerunIntentCount: rerunIntents.length,
    passCount,
    blockedCount: rerun ? 1 - passCount : 1,
    blockers,
    candidates: candidateRows,
    rerun,
    riskReview,
    nextCommand: nextCommandForResult({ passCount, riskReview }),
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
    machineLine: `oppositeExposurePaperRerun=${status};selected=${candidateRows.map((candidate) => candidate.symbol).join("|") || "none"};pass=${passCount};p05=${rerun?.p05TotalPnlPts ?? "missing"};stopHitRate=${rerun?.stopHitRate ?? "missing"};${riskReview.machineLine}`,
  };
}

export async function writeOppositeExposurePaperRerunGate(report) {
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildOppositeExposurePaperRerunGate({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeOppositeExposurePaperRerunGate(report);
  }
  if (options.check) {
    if (
      report.safetyLock?.noLiveOrderSent !== true ||
      report.safetyLock?.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_OPPOSITE_EXPOSURE_PAPER_RERUN_SAFETY_MISMATCH");
    }
    if (
      ![
        "opposite_exposure_tail_passed_requires_promotion_rerun",
        "opposite_exposure_rerun_completed_still_blocked",
        "blocked_no_opposite_exposure_batch",
      ].includes(report.status)
    ) {
      throw new Error(`CAPITAL_OPPOSITE_EXPOSURE_PAPER_RERUN_STATUS_INVALID=${report.status}`);
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
