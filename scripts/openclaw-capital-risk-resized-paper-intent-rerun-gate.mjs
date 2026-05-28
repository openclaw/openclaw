#!/usr/bin/env node
/**
 * Builds and runs a paper-only same-case rerun gate for risk-resized Capital
 * paper intents. It never overwrites active paper intents and never writes or
 * routes broker orders.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1";
const INTENT_SOURCE = "risk_resized_paper_intent_rerun_gate";
const DEFAULT_MAX_ACTIONABLE = 3;

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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundNumber(value, decimals = 6) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

function floorNumber(value, decimals = 6) {
  const scale = 10 ** decimals;
  return Math.floor(Number(value) * scale) / scale;
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

function actionableRiskReviewCandidates(repairReport) {
  return safeArray(repairReport?.repairCandidatePlan?.riskNotionalReviewPlan?.candidates)
    .filter(
      (candidate) =>
        candidate?.reviewAction ===
          "paper_only_reduce_risk_pts_or_use_smaller_contract_then_rerun" &&
        candidate?.canAutoApply === false,
    )
    .slice(0, DEFAULT_MAX_ACTIONABLE);
}

function sideDirection(intent) {
  const value = String(intent?.direction || intent?.side || "").toLowerCase();
  if (["sell", "short"].includes(value)) {
    return "short";
  }
  return "long";
}

function resizedPriceFields(intent, riskPts, rewardPts) {
  const entryPrice = finiteNumber(intent.entryPrice ?? intent.price);
  if (entryPrice === null) {
    return {};
  }
  const direction = sideDirection(intent);
  const priceDecimals = Math.max(
    1,
    Math.min(8, Math.floor(finiteNumber(intent?.meta?.contractRisk?.priceDecimals) ?? 3)),
  );
  const stopPrice =
    direction === "short"
      ? roundNumber(entryPrice + riskPts, priceDecimals)
      : roundNumber(entryPrice - riskPts, priceDecimals);
  const targetPrice =
    direction === "short"
      ? roundNumber(entryPrice - rewardPts, priceDecimals)
      : roundNumber(entryPrice + rewardPts, priceDecimals);
  return {
    targetPrice,
    takeProfit: targetPrice,
    stopPrice,
    stopLoss: stopPrice,
  };
}

function resizeIntent({ intent, reviewCandidate, generatedAt }) {
  let riskPts = finiteNumber(reviewCandidate.paperReviewRiskPts);
  let rewardPts = finiteNumber(reviewCandidate.paperReviewRewardPts);
  const pointValue = finiteNumber(intent.pointValue);
  const qty = finiteNumber(intent.qty) ?? 1;
  if (riskPts === null || rewardPts === null || pointValue === null || pointValue <= 0) {
    return null;
  }
  const maxRiskNotional = finiteNumber(reviewCandidate.maxRiskNotional);
  const pointMultiplier = pointValue * qty;
  if (maxRiskNotional !== null && maxRiskNotional > 0) {
    const currentRiskNotional = roundNumber(riskPts * pointMultiplier);
    if (currentRiskNotional > maxRiskNotional) {
      const rewardRatio = rewardPts > 0 && riskPts > 0 ? rewardPts / riskPts : null;
      riskPts = floorNumber(maxRiskNotional / pointMultiplier);
      rewardPts = rewardRatio !== null ? roundNumber(riskPts * rewardRatio) : rewardPts;
    }
  }
  let riskNotional = roundNumber(riskPts * pointMultiplier);
  if (maxRiskNotional !== null && riskNotional > maxRiskNotional) {
    riskNotional = maxRiskNotional;
  }
  const rewardNotional = roundNumber(rewardPts * pointValue * qty);
  const seed = [
    intent.intentId,
    reviewCandidate.symbol,
    reviewCandidate.riskScale,
    riskPts,
    rewardPts,
    generatedAt,
  ].join("|");
  return {
    ...intent,
    intentId: `capital-risk-resized-paper-${String(reviewCandidate.symbol).toLowerCase()}-${sha256Text(seed).slice(0, 16)}`,
    intentRunId: `capital-risk-resized-paper-rerun-${sha256Text(generatedAt).slice(0, 16)}`,
    generatedAt,
    source: INTENT_SOURCE,
    riskPts,
    rewardPts,
    riskNotional,
    rewardNotional,
    riskRewardRatio: rewardPts > 0 && riskPts > 0 ? roundNumber(rewardPts / riskPts, 6) : null,
    ...resizedPriceFields(intent, riskPts, rewardPts),
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
      riskResizeReview: {
        schema: "openclaw.capital.risk-resized-paper-intent.v1",
        sourceIntentId: intent.intentId ?? "",
        sourceIntentRunId: intent.intentRunId ?? "",
        sourceRiskPts: finiteNumber(reviewCandidate.currentRiskPts),
        sourceRewardPts: finiteNumber(reviewCandidate.currentRewardPts),
        sourceRiskNotional: finiteNumber(reviewCandidate.currentRiskNotional),
        targetMaxRiskNotional: finiteNumber(reviewCandidate.maxRiskNotional),
        riskScale: finiteNumber(reviewCandidate.riskScale),
        noOrderWrite: true,
      },
    },
  };
}

function buildRerunSummary({ symbol, intentPath, simulationPath, simulation }) {
  const p05Pts = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_pts);
  const p05Notional = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_notional);
  const expectedValuePts = finiteNumber(simulation?.stats?.expected_value_pts);
  const maxRiskNotional = finiteNumber(simulation?.stats?.max_risk_notional);
  const tailPass = p05Pts !== null && p05Pts > 0 && p05Notional !== null && p05Notional > 0;
  return {
    symbol,
    status: tailPass ? "paper_resized_tail_passed" : "paper_resized_tail_still_blocked",
    recommendation: String(simulation?.recommendation ?? ""),
    intentPath,
    simulationPath,
    totalIntents: finiteNumber(simulation?.stats?.total_intents),
    maxRiskNotional,
    expectedValuePts,
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

function formatRejectNumber(value) {
  return value === null || value === undefined ? "missing" : String(value);
}

function buildRejectionReason(rerun) {
  const reasons = [];
  if (rerun.p05TotalPnlPts === null || rerun.p05TotalPnlPts <= 0) {
    reasons.push("p05_total_pnl_pts_not_positive");
  }
  if (rerun.p05TotalPnlNotional === null || rerun.p05TotalPnlNotional <= 0) {
    reasons.push("p05_total_pnl_notional_not_positive");
  }
  if (reasons.length === 0 && rerun.status !== "paper_resized_tail_passed") {
    reasons.push("tail_status_not_passed");
  }
  return reasons;
}

function buildRejectionSummary({ status, resizedCandidates, reruns, blockers }) {
  const candidateBySymbol = new Map(
    resizedCandidates.map((candidate) => [candidate.symbol, candidate]),
  );
  const rejectedCandidates = reruns
    .filter((rerun) => rerun.status !== "paper_resized_tail_passed")
    .map((rerun) => {
      const candidate = candidateBySymbol.get(rerun.symbol) ?? {};
      const rejectionReasons = buildRejectionReason(rerun);
      return {
        symbol: rerun.symbol,
        decision: "reject_for_promotion",
        status: rerun.status,
        rejectionReasons,
        expectedValuePts: rerun.expectedValuePts,
        p05TotalPnlPts: rerun.p05TotalPnlPts,
        p05TotalPnlNotional: rerun.p05TotalPnlNotional,
        maxRiskNotional: rerun.maxRiskNotional,
        currentRiskNotional: candidate.currentRiskNotional ?? null,
        resizedRiskNotional: candidate.resizedRiskNotional ?? null,
        resizedRiskPts: candidate.resizedRiskPts ?? null,
        resizedRewardPts: candidate.resizedRewardPts ?? null,
        nextAction: "do_not_promote_wait_for_new_signal_or_refresh_tail_risk_repair",
        noOrderWrite: true,
      };
    });
  const passedSymbols = reruns
    .filter((rerun) => rerun.status === "paper_resized_tail_passed")
    .map((rerun) => rerun.symbol);
  const statusText =
    blockers.length > 0 && reruns.length === 0
      ? "blocked_no_rejection_sample"
      : rejectedCandidates.length > 0 && passedSymbols.length === 0
        ? "all_candidates_rejected"
        : rejectedCandidates.length > 0
          ? "mixed_pass_and_reject"
          : passedSymbols.length > 0
            ? "no_rejections_tail_passed"
            : "no_candidates";
  return {
    schema: "openclaw.capital.risk-resized-paper-rejection-summary.v1",
    status: statusText,
    sourceStatus: status,
    rejectedCount: rejectedCandidates.length,
    passCount: passedSymbols.length,
    blockedCount: rejectedCandidates.length,
    passedSymbols,
    rejectedCandidates,
    blockers,
    requiredPassConditions: [
      "p05_total_pnl_pts > 0",
      "p05_total_pnl_notional > 0",
      "same-case simulation remains paper-only",
    ],
    conclusion:
      rejectedCandidates.length > 0
        ? "縮風險後尾端 p05 仍未轉正，候選不得升級 promotion，也不得進入 operator packet。"
        : "沒有可淘汰候選；等待下一輪 risk-resized rerun 證據。",
    nextCommand:
      passedSymbols.length > 0
        ? "pnpm capital:strategy:fill-simulation:check"
        : "pnpm capital:strategy:tail-risk-repair:check",
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: [
      `riskResizedRejectionSummary=${statusText}`,
      `rejected=${rejectedCandidates.map((candidate) => candidate.symbol).join("|") || "none"}`,
      `pass=${passedSymbols.join("|") || "none"}`,
      `p05Pts=${
        rejectedCandidates
          .map((candidate) => `${candidate.symbol}:${formatRejectNumber(candidate.p05TotalPnlPts)}`)
          .join("|") || "none"
      }`,
      `p05Notional=${
        rejectedCandidates
          .map(
            (candidate) =>
              `${candidate.symbol}:${formatRejectNumber(candidate.p05TotalPnlNotional)}`,
          )
          .join("|") || "none"
      }`,
      `next=${passedSymbols.length > 0 ? "fill-simulation-check" : "tail-risk-repair-check"}`,
      "noOrderWrite=true",
    ].join(";"),
  };
}

export async function buildRiskResizedPaperIntentRerunGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const repairReportPath =
    options.repairReportPath ??
    path.join(stateRoot, "openclaw-capital-strategy-tail-risk-repair-latest.json");
  const currentIntentsPath =
    options.currentIntentsPath ??
    path.join(tradingRoot, "capital-current-paper-intents-from-target-registry.jsonl");
  const reportPath =
    options.reportPath ??
    path.join(stateRoot, "openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json");
  const panelPath =
    options.panelPath ??
    path.join(tradingRoot, "capital-risk-resized-paper-intent-rerun-gate.json");
  const artifactDir =
    options.artifactDir ?? path.join(tradingRoot, "capital-risk-resized-paper-rerun");

  const repairReport = await readJsonIfExists(repairReportPath);
  const currentIntentText = await readTextIfExists(currentIntentsPath);
  const sourceIntents = currentIntentText ? parseJsonLines(currentIntentText) : [];
  const sourceIntentBySymbol = new Map(
    sourceIntents.map((intent) => [String(intent.symbol ?? "").toUpperCase(), intent]),
  );
  const actionableCandidates = repairReport ? actionableRiskReviewCandidates(repairReport) : [];
  const resizedCandidates = [];
  const reruns = [];
  const blockers = [];

  if (!repairReport) {
    blockers.push("tail_risk_repair_report_missing");
  }
  if (sourceIntents.length === 0) {
    blockers.push("current_paper_intents_missing");
  }
  if (actionableCandidates.length === 0) {
    blockers.push("no_actionable_risk_resized_candidates");
  }

  for (const candidate of actionableCandidates) {
    const symbol = String(candidate.symbol ?? "").toUpperCase();
    const sourceIntent = sourceIntentBySymbol.get(symbol);
    if (!sourceIntent) {
      blockers.push(`source_intent_missing:${symbol}`);
      continue;
    }
    const resizedIntent = resizeIntent({
      intent: sourceIntent,
      reviewCandidate: candidate,
      generatedAt,
    });
    if (!resizedIntent) {
      blockers.push(`risk_resize_fields_missing:${symbol}`);
      continue;
    }
    const intentText = `${JSON.stringify(resizedIntent)}\n`;
    const intentPath = path.join(artifactDir, `${symbol.toLowerCase()}-risk-resized-intent.jsonl`);
    const simulationPath = path.join(
      artifactDir,
      `${symbol.toLowerCase()}-risk-resized-fill-simulation.json`,
    );
    await writeTextWithSha(intentPath, intentText);
    const simulation = await runStrategyFillSimulation({
      repoRoot,
      intentsPath: intentPath,
      outputPath: simulationPath,
      fallbackIntentsPath: intentPath,
      monteCarloIterations: options.monteCarloIterations ?? 500,
    });
    resizedCandidates.push({
      symbol,
      sourceIntentId: sourceIntent.intentId ?? "",
      resizedIntentId: resizedIntent.intentId,
      currentRiskPts: finiteNumber(candidate.currentRiskPts),
      resizedRiskPts: finiteNumber(resizedIntent.riskPts),
      currentRewardPts: finiteNumber(candidate.currentRewardPts),
      resizedRewardPts: finiteNumber(resizedIntent.rewardPts),
      currentRiskNotional: finiteNumber(candidate.currentRiskNotional),
      resizedRiskNotional: finiteNumber(resizedIntent.riskNotional),
      maxRiskNotional: finiteNumber(candidate.maxRiskNotional),
      riskScale: finiteNumber(candidate.riskScale),
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

  const passCount = reruns.filter((rerun) => rerun.status === "paper_resized_tail_passed").length;
  const status =
    blockers.length > 0 && reruns.length === 0
      ? "blocked_no_rerun_ready"
      : passCount > 0
        ? "paper_resized_candidate_tail_passed_requires_promotion_rerun"
        : reruns.length > 0
          ? "paper_resized_rerun_completed_still_blocked"
          : "blocked_no_rerun_ready";
  const rejectionSummary = buildRejectionSummary({
    status,
    resizedCandidates,
    reruns,
    blockers,
  });
  const report = {
    schema: SCHEMA,
    generatedAt,
    status,
    repoRoot,
    source: {
      repairReportPath: toRepoPath(repoRoot, repairReportPath),
      currentIntentsPath: toRepoPath(repoRoot, currentIntentsPath),
      sourceIntentCount: sourceIntents.length,
      sourceIntentDigest: currentIntentText ? sha256Text(currentIntentText) : "",
      repairStatus: String(repairReport?.status ?? ""),
      riskNotionalReviewStatus: String(
        repairReport?.repairCandidatePlan?.riskNotionalReviewPlan?.status ?? "",
      ),
    },
    resizedCandidateCount: resizedCandidates.length,
    passCount,
    blockedCount: reruns.length - passCount,
    blockers,
    resizedCandidates,
    reruns,
    rejectionSummary,
    nextCommand:
      passCount > 0
        ? {
            command: "pnpm capital:strategy:fill-simulation:check",
            reason:
              "At least one resized paper candidate passed tail p05; rerun normal promotion gate before any operator packet.",
          }
        : {
            command: "pnpm capital:strategy:tail-risk-repair:check",
            reason:
              "Risk-resized same-case rerun still blocked; refresh candidates or wait for stronger paper evidence.",
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
    machineLine: `riskResizedPaperRerun=${status};candidates=${resizedCandidates.map((candidate) => candidate.symbol).join("|") || "none"};pass=${passCount};blocked=${reruns.length - passCount};rejectionSummary=${rejectionSummary.status};noOrderWrite=true`,
  };
  return report;
}

export async function writeRiskResizedPaperIntentRerunGate(report) {
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
  const report = await buildRiskResizedPaperIntentRerunGate({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeRiskResizedPaperIntentRerunGate(report);
  }
  if (options.check) {
    if (
      report.safetyLock?.noLiveOrderSent !== true ||
      report.safetyLock?.writeBrokerOrders !== false
    ) {
      throw new Error("CAPITAL_RISK_RESIZED_PAPER_RERUN_SAFETY_MISMATCH");
    }
    if (
      ![
        "paper_resized_candidate_tail_passed_requires_promotion_rerun",
        "paper_resized_rerun_completed_still_blocked",
        "blocked_no_rerun_ready",
      ].includes(report.status)
    ) {
      throw new Error(`CAPITAL_RISK_RESIZED_PAPER_RERUN_STATUS_INVALID=${report.status}`);
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
