#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalStrategyTailRiskRepair } from "./openclaw-capital-strategy-tail-risk-repair.mjs";

const SCHEMA = "openclaw.capital.fresh-paper-candidate-collector.v1";
const MAX_FRESH_SECONDS = 300;
const MAX_SELECTED_CANDIDATES = 5;

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state"),
  };
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonlIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return [];
    }
    throw error;
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function exposureDirection(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (["buy", "long"].includes(normalized)) {
    return "long";
  }
  if (["sell", "short"].includes(normalized)) {
    return "short";
  }
  return "";
}

function marketGroupForSymbol(symbol, marketCode = "") {
  const rawCode = String(marketCode || symbol).toUpperCase();
  const alnumCode = rawCode.replace(/[^A-Z0-9]/g, "");
  const code = rawCode.replace(/[^A-Z]/g, "");
  if (["6C", "CD", "CD0000", "CAD"].includes(alnumCode) || ["CD", "CAD"].includes(code)) {
    return "fx";
  }
  if (["ES", "MES", "NQ", "MNQ", "YM", "MYM"].includes(code)) {
    return "us_equity_index";
  }
  if (["CL", "MCL", "QM", "BZ"].includes(code)) {
    return "energy";
  }
  if (["GC", "MGC", "SI", "SIL"].includes(code)) {
    return "metal";
  }
  if (["CN", "A50"].includes(code)) {
    return "china_index";
  }
  if (["TX", "TXF", "MTX"].includes(code)) {
    return "taiwan_index";
  }
  return code || "unknown";
}

function timestampAgeSeconds(value, nowMs) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function currentFreshAge(intent, nowMs) {
  const receivedAge = timestampAgeSeconds(intent?.sourceEvent?.receivedAt, nowMs);
  const storedAge = finiteNumber(
    intent?.sourceEvent?.wallClockAgeSeconds ?? intent?.sourceEvent?.ageSeconds,
  );
  const age = receivedAge ?? storedAge;
  const maxFreshSeconds = finiteNumber(intent?.sourceEvent?.maxFreshSeconds) ?? MAX_FRESH_SECONDS;
  return { age, maxFreshSeconds };
}

function isFreshResolvedPaperIntent(intent, nowMs) {
  const { age, maxFreshSeconds } = currentFreshAge(intent, nowMs);
  return (
    intent?.paperOnly === true &&
    intent?.executionEligible === true &&
    intent?.routeReady === true &&
    intent?.resolverReady !== false &&
    intent?.historicalSnapshot !== true &&
    intent?.paperExplorationOnly !== true &&
    intent?.promotionBlocked !== true &&
    intent?.sourceEvent?.freshnessStatus === "fresh" &&
    age !== null &&
    age >= 0 &&
    age <= maxFreshSeconds &&
    intent?.allowLiveTrading !== true &&
    intent?.liveTradingEnabled !== true &&
    intent?.writeBrokerOrders !== true &&
    intent?.writeTradingEnabled !== true &&
    intent?.brokerOrderPathEnabled !== true &&
    intent?.promoteLiveAuto !== true &&
    intent?.promoteLiveAutomatically !== true
  );
}

function hasKnownPointValue(intent) {
  const riskNotional = finiteNumber(intent?.riskNotional);
  return (
    String(intent?.pointValueCurrency ?? "") !== "" &&
    String(intent?.pointValueCurrency ?? "") !== "POINT" &&
    riskNotional !== null &&
    riskNotional > 0
  );
}

function candidateFromIntent(intent, selectedGroups, selectedDirections, selectedSymbols, nowMs) {
  const symbol = normalizedSymbol(intent?.symbol);
  const marketCode = normalizedSymbol(intent?.marketCode);
  const direction = exposureDirection(intent?.direction || intent?.side);
  const marketGroup = marketGroupForSymbol(symbol, marketCode);
  const { age, maxFreshSeconds } = currentFreshAge(intent, nowMs);
  const oppositeExposure =
    direction !== "" &&
    selectedDirections.length > 0 &&
    selectedDirections.some((selectedDirection) => selectedDirection !== direction);
  const crossGroupProxy =
    marketGroup !== "unknown" && selectedGroups.length > 0 && !selectedGroups.includes(marketGroup);
  return {
    symbol,
    intentId: String(intent?.intentId ?? ""),
    targetId: String(intent?.targetId ?? ""),
    marketCode,
    marketGroup,
    direction,
    side: String(intent?.side ?? ""),
    strategy: String(intent?.strategy ?? intent?.strategyName ?? ""),
    freshResolved: isFreshResolvedPaperIntent(intent, nowMs),
    knownPointValue: hasKnownPointValue(intent),
    oppositeExposure,
    crossGroupProxy,
    excludedCurrentSymbol: selectedSymbols.includes(symbol),
    confidence: finiteNumber(intent?.confidence),
    riskPts: finiteNumber(intent?.riskPts),
    rewardPts: finiteNumber(intent?.rewardPts),
    riskNotional: finiteNumber(intent?.riskNotional),
    rewardNotional: finiteNumber(intent?.rewardNotional),
    pointValueCurrency: String(intent?.pointValueCurrency ?? ""),
    sourceFreshnessStatus: String(intent?.sourceEvent?.freshnessStatus ?? ""),
    sourceWallClockAgeSeconds: age,
    maxFreshSeconds,
    noLiveOrderSent: intent?.meta?.noLiveOrderSent === true,
    paperOnly: intent?.paperOnly === true,
  };
}

function compareCandidates(left, right) {
  const leftRisk = finiteNumber(left?.riskNotional) ?? Number.POSITIVE_INFINITY;
  const rightRisk = finiteNumber(right?.riskNotional) ?? Number.POSITIVE_INFINITY;
  if (leftRisk !== rightRisk) {
    return leftRisk - rightRisk;
  }
  const leftConfidence = finiteNumber(left?.confidence) ?? 0;
  const rightConfidence = finiteNumber(right?.confidence) ?? 0;
  if (leftConfidence !== rightConfidence) {
    return rightConfidence - leftConfidence;
  }
  return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "")).filter(Boolean))];
}

function normalizedReplaySymbols(symbols) {
  return uniqueStrings(safeArray(symbols).map((symbol) => normalizedSymbol(symbol)))
    .filter(Boolean)
    .toSorted();
}

function replayBasketKey(symbols) {
  return normalizedReplaySymbols(symbols).join("|");
}

function replayEvidenceForIntent(intent) {
  const sourceEvent = intent?.sourceEvent ?? {};
  return {
    symbol: normalizedSymbol(intent?.symbol),
    targetId: String(intent?.targetId ?? ""),
    strategy: String(intent?.strategy ?? intent?.strategyName ?? ""),
    side: String(intent?.side ?? intent?.direction ?? ""),
    entryPrice: finiteNumber(intent?.entryPrice ?? intent?.price),
    stopPrice: finiteNumber(intent?.stopPrice ?? intent?.stopLoss),
    targetPrice: finiteNumber(intent?.targetPrice ?? intent?.takeProfit),
    riskPts: finiteNumber(intent?.riskPts),
    rewardPts: finiteNumber(intent?.rewardPts),
    riskNotional: finiteNumber(intent?.riskNotional),
    confidence: finiteNumber(intent?.confidence),
    sourceReceivedAt: String(sourceEvent?.receivedAt ?? ""),
    source: String(sourceEvent?.source ?? ""),
    bid: finiteNumber(sourceEvent?.bid),
    ask: finiteNumber(sourceEvent?.ask),
    close: finiteNumber(sourceEvent?.close),
    priceScale: finiteNumber(sourceEvent?.priceScale),
  };
}

function replayEvidenceDigestForIntents(intents) {
  const evidence = intents.map(replayEvidenceForIntent).toSorted((left, right) => {
    if (left.symbol !== right.symbol) {
      return left.symbol.localeCompare(right.symbol);
    }
    return left.targetId.localeCompare(right.targetId);
  });
  return sha256Text(JSON.stringify(evidence));
}

function currentIntentBySymbol(currentIntents) {
  const bySymbol = new Map();
  for (const intent of currentIntents) {
    const symbol = normalizedSymbol(intent?.symbol);
    if (symbol) {
      bySymbol.set(symbol, intent);
    }
  }
  return bySymbol;
}

function failedReplayHistoryFromTailRisk(tailRiskRepair) {
  return (
    tailRiskRepair?.repairCandidatePlan?.nextPaperCandidateBatch?.sameCaseRerunEvidence
      ?.replayOutcome?.failedReplayHistory ?? {}
  );
}

function buildFailedReplayQuoteDigestGate(tailRiskRepair, currentIntents) {
  const history = failedReplayHistoryFromTailRisk(tailRiskRepair);
  const baskets = safeArray(history?.baskets);
  const bySymbol = currentIntentBySymbol(currentIntents);
  const digestKeys = new Set(
    baskets
      .filter((basket) => String(basket?.evidenceDigest ?? "").trim() !== "")
      .map((basket) => replayBasketKey(basket?.symbols))
      .filter(Boolean),
  );
  const activeBaskets = [];
  const staleBaskets = [];
  const legacyLockedBaskets = [];
  const activeSymbols = [];
  const unlockedSymbols = [];
  for (const basket of baskets) {
    const symbols = normalizedReplaySymbols(basket?.symbols);
    const key = replayBasketKey(symbols);
    const evidenceDigest = String(basket?.evidenceDigest ?? "").toUpperCase();
    const currentIntentsForBasket = symbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
    if (symbols.length === 0) {
      staleBaskets.push({ key, reason: "empty_symbol_basket" });
      continue;
    }
    if (currentIntentsForBasket.length !== symbols.length) {
      staleBaskets.push({ key, symbols, reason: "candidate_not_current" });
      unlockedSymbols.push(...symbols);
      continue;
    }
    if (!evidenceDigest) {
      if (digestKeys.has(key)) {
        staleBaskets.push({ key, symbols, reason: "legacy_basket_shadowed_by_digest_evidence" });
        continue;
      }
      legacyLockedBaskets.push({ key, symbols, reason: "legacy_basket_without_digest" });
      activeSymbols.push(...symbols);
      continue;
    }
    const currentDigest = replayEvidenceDigestForIntents(currentIntentsForBasket);
    if (currentDigest === evidenceDigest) {
      activeBaskets.push({ key, symbols, evidenceDigest, currentDigest });
      activeSymbols.push(...symbols);
    } else {
      staleBaskets.push({
        key,
        symbols,
        evidenceDigest,
        currentDigest,
        reason: "quote_digest_changed",
      });
      unlockedSymbols.push(...symbols);
    }
  }
  const activeExcludedSymbols = normalizedReplaySymbols(activeSymbols);
  const staleUnlockedSymbols = normalizedReplaySymbols(unlockedSymbols).filter(
    (symbol) => !activeExcludedSymbols.includes(symbol),
  );
  const status =
    activeExcludedSymbols.length > 0
      ? staleUnlockedSymbols.length > 0
        ? "partial_lock_active_quote_digest_gate"
        : "lock_active_same_quote_digest"
      : staleUnlockedSymbols.length > 0
        ? "unlocked_quote_digest_changed"
        : baskets.length > 0
          ? "blocked_legacy_or_stale_baskets_only"
          : "clear_no_failed_replay_history";
  return {
    schema: "openclaw.capital.failed-replay-quote-digest-gate.v1",
    status,
    basketCount: baskets.length,
    activeBasketCount: activeBaskets.length,
    staleBasketCount: staleBaskets.length,
    legacyLockedBasketCount: legacyLockedBaskets.length,
    activeExcludedSymbols,
    staleUnlockedSymbols,
    activeBaskets,
    staleBaskets,
    legacyLockedBaskets,
    unlockRule:
      "failed replay ban applies only when current quote digest matches the failed replay evidence digest",
    safetyLock: {
      paperOnly: true,
      noBrokerApiCalled: true,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `failedReplayQuoteDigestGate=${status};active=${activeExcludedSymbols.join("|") || "none"};unlocked=${staleUnlockedSymbols.join("|") || "none"};activeBaskets=${activeBaskets.length};staleBaskets=${staleBaskets.length};legacyLocked=${legacyLockedBaskets.length};noOrderWrite=true`,
  };
}

function selectedReferenceFromTailRisk(tailRiskRepair, currentIntents) {
  const selectedDiagnostics = safeArray(tailRiskRepair?.selectedDiagnostics);
  const selectedSymbols = uniqueStrings(
    safeArray(tailRiskRepair?.selectedSymbols).map((symbol) => normalizedSymbol(symbol)),
  );
  const selectedDirections = uniqueStrings(
    selectedDiagnostics.map((diagnostic) =>
      exposureDirection(diagnostic?.direction || diagnostic?.side || "long"),
    ),
  );
  const selectedMarketGroups = uniqueStrings(
    selectedDiagnostics
      .map((diagnostic) => marketGroupForSymbol(diagnostic?.symbol, diagnostic?.marketCode))
      .filter((group) => group !== "unknown"),
  );
  if (selectedMarketGroups.length === 0 && selectedSymbols.length > 0) {
    selectedMarketGroups.push(
      ...uniqueStrings(
        selectedSymbols
          .map((symbol) => marketGroupForSymbol(symbol))
          .filter((group) => group !== "unknown"),
      ),
    );
  }
  const failedReplayQuoteDigestGate = buildFailedReplayQuoteDigestGate(
    tailRiskRepair,
    currentIntents,
  );
  return {
    selectedSymbols,
    selectedDirections: selectedDirections.length > 0 ? selectedDirections : ["long"],
    selectedMarketGroups,
    selectedDiagnostics,
    excludedFailedReplaySymbols: failedReplayQuoteDigestGate.activeExcludedSymbols,
    failedReplayQuoteDigestGate,
  };
}

function buildReport({ repoRoot, currentIntents, tailRiskRepair }) {
  const nowMs = Date.now();
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-fresh-paper-candidate-collector-latest.json",
  );
  const panelPath = path.join(tradingRoot, "capital-fresh-paper-candidate-collector.json");
  const intentsPath = path.join(
    tradingRoot,
    "capital-current-paper-intents-from-target-registry.jsonl",
  );
  const selectedReference = selectedReferenceFromTailRisk(tailRiskRepair, currentIntents);
  const candidates = currentIntents
    .map((intent) =>
      candidateFromIntent(
        intent,
        selectedReference.selectedMarketGroups,
        selectedReference.selectedDirections,
        selectedReference.selectedSymbols,
        nowMs,
      ),
    )
    .filter((candidate) => !candidate.excludedCurrentSymbol)
    .map((candidate) => ({
      ...candidate,
      failedReplayExcluded: selectedReference.excludedFailedReplaySymbols.includes(
        candidate.symbol,
      ),
    }));
  const eligibleCandidates = candidates
    .filter(
      (candidate) =>
        candidate.freshResolved &&
        candidate.knownPointValue &&
        candidate.failedReplayExcluded !== true &&
        (candidate.crossGroupProxy || candidate.oppositeExposure),
    )
    .toSorted(compareCandidates);
  const selectedCandidates = eligibleCandidates.slice(0, MAX_SELECTED_CANDIDATES);
  const failedReplayExcludedCount = candidates.filter(
    (candidate) => candidate.failedReplayExcluded === true,
  ).length;
  const crossGroupCandidateCount = candidates.filter(
    (candidate) =>
      candidate.freshResolved && candidate.knownPointValue && candidate.crossGroupProxy,
  ).length;
  const oppositeCandidateCount = candidates.filter(
    (candidate) =>
      candidate.freshResolved && candidate.knownPointValue && candidate.oppositeExposure,
  ).length;
  const status =
    selectedCandidates.length > 0
      ? "candidate_pool_ready_for_same_case_rerun"
      : failedReplayExcludedCount > 0
        ? "blocked_failed_replay_rotation_exhausted"
        : candidates.length > 0
          ? "blocked_candidate_quality_incomplete"
          : "blocked_no_fresh_candidates";
  const machineLine = [
    `freshPaperCandidates=${status}`,
    `freshResolved=${candidates.filter((candidate) => candidate.freshResolved).length}`,
    `knownPoint=${candidates.filter((candidate) => candidate.knownPointValue).length}`,
    `crossGroup=${crossGroupCandidateCount}`,
    `opposite=${oppositeCandidateCount}`,
    `failedReplayExcluded=${selectedReference.excludedFailedReplaySymbols.join("|") || "none"}`,
    `skippedFailedReplay=${failedReplayExcludedCount}`,
    `selected=${selectedCandidates.map((candidate) => candidate.symbol).join("|") || "none"}`,
    `tailRisk=${tailRiskRepair?.status ?? "unknown"}`,
    `next=${
      selectedCandidates.length > 0
        ? "pnpm_capital_strategy_fill_simulation_check"
        : "pnpm_capital_trade_current_paper_intents"
    }`,
    "noOrderWrite=true",
  ].join(" ");
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    status,
    source: {
      currentIntentsPath: intentsPath,
      tailRiskRepairStatus: tailRiskRepair?.status ?? "unknown",
      tailRiskMachineLine: tailRiskRepair?.machineLine ?? "",
      noBrokerApiCalled: true,
    },
    selectedReference: {
      selectedSymbols: selectedReference.selectedSymbols,
      selectedMarketGroups: selectedReference.selectedMarketGroups,
      selectedDirections: selectedReference.selectedDirections,
      excludedFailedReplaySymbols: selectedReference.excludedFailedReplaySymbols,
      failedReplayQuoteDigestGate: selectedReference.failedReplayQuoteDigestGate,
    },
    counts: {
      currentIntentCount: currentIntents.length,
      candidateCount: candidates.length,
      freshResolvedCount: candidates.filter((candidate) => candidate.freshResolved).length,
      knownPointValueCount: candidates.filter((candidate) => candidate.knownPointValue).length,
      crossGroupCandidateCount,
      oppositeCandidateCount,
      eligibleCandidateCount: eligibleCandidates.length,
      selectedCandidateCount: selectedCandidates.length,
      failedReplayExcludedCount,
      availableAfterFailedReplayExclusionCount: eligibleCandidates.length,
    },
    selectedCandidates,
    candidateQualityEvidence: {
      status:
        selectedCandidates.length > 0
          ? "candidate_quality_ready_for_rerun"
          : failedReplayExcludedCount > 0
            ? "blocked_failed_replay_rotation_exhausted"
            : "blocked_candidate_quality_incomplete",
      requiredPass: [
        "freshResolved=true",
        "knownPointValue=true",
        "failedReplayExcluded=false",
        "crossGroupProxy=true or oppositeExposure=true",
        "paperOnly=true",
        "no live/write flags",
      ],
      topRejectedCandidates: candidates
        .filter(
          (candidate) =>
            !selectedCandidates.some((selected) => selected.symbol === candidate.symbol),
        )
        .toSorted(compareCandidates)
        .slice(0, 5),
    },
    safetyLock: {
      paperOnly: true,
      noBrokerApiCalled: true,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    machineLine,
    nextCommand:
      selectedCandidates.length > 0
        ? "pnpm capital:strategy:fill-simulation:check"
        : "pnpm capital:trade:current-paper-intents",
    nextSafeTask:
      selectedCandidates.length > 0
        ? "rerun capital:strategy:fill-simulation:check with the fresh cross-group paper candidate batch evidence"
        : "refresh current paper intents and wait for a changed quote digest before rerunning failed replay candidates",
    paths: {
      reportPath,
      panelPath,
    },
  };
}

export async function runCapitalFreshPaperCandidateCollector(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const intentsPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-current-paper-intents-from-target-registry.jsonl",
  );
  const [currentIntents, tailRiskRepair] = await Promise.all([
    readJsonlIfExists(intentsPath),
    runCapitalStrategyTailRiskRepair({ repoRoot }),
  ]);
  const report = buildReport({ repoRoot, currentIntents, tailRiskRepair });
  if (options.writeState === true) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalFreshPaperCandidateCollector({
    repoRoot: process.cwd(),
    writeState: options.writeState,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.machineLine}\n`);
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
