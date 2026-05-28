#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/brokerdesk-state-dir.mjs";
import {
  openclawPnpmCommand,
  qualifyOpenClawPnpmCommands,
} from "./lib/openclaw-command-surface.mjs";

const SCHEMA = "openclaw.capital.current-paper-intents-from-target-registry.v1";
const INTENT_SCHEMA = "openclaw.capital.paper-intent.v2";
const MAX_FRESH_SECONDS = 300;
const TAIL_CONTROL_MAX_SPREAD_RATIO = 0.0006;
const TAIL_CONTROL_MAX_RISK_NOTIONAL = 300;
const TAIL_CONTROL_MIN_CONFIDENCE = 0.59;
const TAIL_CONTROL_FILL_RATE_ASSUMPTION = 0.99;
const TAIL_CONTROL_STOP_TO_SCRATCH_RATE = 0.98;
const INVALID_LEGACY_SYMBOLS = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);
const CANDIDATE_READINESS = new Set([
  "ready_for_current_paper_intent",
  "quote_fresh_but_strategy_route_blocked",
  "core_quote_fresh_route_blocked",
]);
const ALLOWED_STATUSES = new Set([
  "current_paper_intents_written",
  "blocked_no_fresh_price_targets",
  "blocked_platform_report_missing",
]);
const CONTRACT_RISK_SPECS = [
  { roots: ["TX"], pointValue: 200, currency: "TWD", confidence: "medium" },
  { roots: ["MTX"], pointValue: 50, currency: "TWD", confidence: "medium" },
  { roots: ["CN"], pointValue: 1, currency: "USD", confidence: "medium" },
  {
    roots: ["CD", "6C"],
    pointValue: 100000,
    currency: "USD",
    confidence: "medium",
    minRiskPts: 0.00005,
    priceDecimals: 5,
  },
  { roots: ["CL"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["BZ"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["QM"], pointValue: 500, currency: "USD", confidence: "medium" },
  { roots: ["MCL"], pointValue: 100, currency: "USD", confidence: "medium" },
  { roots: ["NG"], pointValue: 10000, currency: "USD", confidence: "medium", minRiskPts: 0.001 },
  { roots: ["QG"], pointValue: 2500, currency: "USD", confidence: "medium", minRiskPts: 0.001 },
  {
    roots: ["RB"],
    pointValue: 42000,
    currency: "USD",
    confidence: "medium",
    minRiskPts: 0.0001,
    priceDecimals: 4,
  },
  {
    roots: ["HO"],
    pointValue: 4.2,
    currency: "USD",
    confidence: "low",
    minRiskPts: 1,
    priceDecimals: 0,
  },
  { roots: ["GC"], pointValue: 100, currency: "USD", confidence: "medium" },
  { roots: ["MGC"], pointValue: 10, currency: "USD", confidence: "medium" },
  { roots: ["SI"], pointValue: 50, currency: "USD", confidence: "medium", minRiskPts: 0.5 },
  { roots: ["HG"], pointValue: 2.5, currency: "USD", confidence: "low", minRiskPts: 5 },
  { roots: ["ES"], pointValue: 50, currency: "USD", confidence: "medium" },
  { roots: ["MES"], pointValue: 5, currency: "USD", confidence: "medium" },
  { roots: ["NQ"], pointValue: 20, currency: "USD", confidence: "medium" },
  { roots: ["MNQ"], pointValue: 2, currency: "USD", confidence: "medium" },
  { roots: ["YM"], pointValue: 5, currency: "USD", confidence: "medium" },
  { roots: ["MYM"], pointValue: 0.5, currency: "USD", confidence: "medium" },
  { roots: ["RTY"], pointValue: 50, currency: "USD", confidence: "medium" },
  { roots: ["M2K"], pointValue: 5, currency: "USD", confidence: "medium" },
  { roots: ["ZT", "TU"], pointValue: 2000, currency: "USD", confidence: "medium" },
  { roots: ["ZF", "FV"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["ZN", "TY"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["TN"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["ZB", "US"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["UB"], pointValue: 1000, currency: "USD", confidence: "medium" },
  { roots: ["DAX"], pointValue: 25, currency: "EUR", confidence: "low" },
  { roots: ["DXM"], pointValue: 5, currency: "EUR", confidence: "low" },
  { roots: ["DXS"], pointValue: 1, currency: "EUR", confidence: "low" },
  { roots: ["FESX", "ESX"], pointValue: 10, currency: "EUR", confidence: "medium" },
  { roots: ["AP"], pointValue: 25, currency: "AUD", confidence: "low" },
  { roots: ["NK"], pointValue: 5, currency: "USD", confidence: "low" },
  { roots: ["VX"], pointValue: 1000, currency: "USD", confidence: "medium", minRiskPts: 0.01 },
  { roots: ["VXM"], pointValue: 100, currency: "USD", confidence: "medium", minRiskPts: 0.01 },
  { roots: ["C"], pointValue: 50, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["S"], pointValue: 50, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["W"], pointValue: 50, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["YC"], pointValue: 10, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["YK"], pointValue: 10, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["YW"], pointValue: 10, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  { roots: ["MZL"], pointValue: 60, currency: "USD", confidence: "medium", minRiskPts: 0.01 },
  { roots: ["O"], pointValue: 50, currency: "USD", confidence: "medium", minRiskPts: 0.25 },
  {
    roots: ["FF", "ZQ"],
    pointValue: 4167,
    currency: "USD",
    confidence: "medium",
    minRiskPts: 0.0025,
  },
  { roots: ["10Y"], pointValue: 1000, currency: "USD", confidence: "low", minRiskPts: 0.001 },
  { roots: ["BO"], pointValue: 600, currency: "USD", confidence: "medium" },
  { roots: ["SM"], pointValue: 100, currency: "USD", confidence: "medium" },
].toSorted((left, right) => right.roots[0].length - left.roots[0].length);

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

async function buildRiskResizedArtifactRejectionHistory(artifactDir) {
  let entries = [];
  try {
    entries = await fs.readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      return {
        schema: "openclaw.capital.current-paper-risk-resized-artifact-history.v1",
        status: "missing",
        artifactDir,
        rejectedSymbols: [],
        entries: [],
        noOrderWrite: true,
      };
    }
    throw error;
  }

  const rejectedEntries = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = /^([a-z0-9]+)-risk-resized-fill-simulation\.json$/iu.exec(entry.name);
    if (!match) {
      continue;
    }
    const symbol = normalizedSymbol(match[1]);
    const filePath = path.join(artifactDir, entry.name);
    const simulation = await readJsonIfExists(filePath);
    const p05TotalPnlPts = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_pts);
    const p05TotalPnlNotional = finiteNumber(simulation?.monteCarlo?.p05_total_pnl_notional);
    const noLiveOrderSent =
      simulation?.safetyLock?.noLiveOrderSent === true ||
      simulation?.promotionGate?.noLiveOrderSent === true;
    if (
      !symbol ||
      noLiveOrderSent !== true ||
      !(
        (p05TotalPnlPts !== null && p05TotalPnlPts <= 0) ||
        (p05TotalPnlNotional !== null && p05TotalPnlNotional <= 0)
      )
    ) {
      continue;
    }
    rejectedEntries.push({
      symbol,
      path: filePath,
      generatedAt: simulation?.generatedAt ?? "",
      status: simulation?.status ?? "",
      recommendation: simulation?.recommendation ?? "",
      p05TotalPnlPts,
      p05TotalPnlNotional,
      noOrderWrite: true,
    });
  }

  const rejectedSymbols = [...new Set(rejectedEntries.map((entry) => entry.symbol))].toSorted();
  return {
    schema: "openclaw.capital.current-paper-risk-resized-artifact-history.v1",
    status: rejectedSymbols.length > 0 ? "active" : "empty",
    artifactDir,
    rejectedSymbols,
    entries: rejectedEntries.toSorted((left, right) => left.symbol.localeCompare(right.symbol)),
    noOrderWrite: true,
  };
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state"),
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildRiskResizedRejectionExclusion(report, artifactHistory) {
  const rejectionSummary = report?.rejectionSummary ?? null;
  const latestRejectedSymbols = safeArray(rejectionSummary?.rejectedCandidates)
    .map((candidate) => normalizedSymbol(candidate?.symbol))
    .filter(Boolean)
    .toSorted();
  const artifactRejectedSymbols = safeArray(artifactHistory?.rejectedSymbols)
    .map((symbol) => normalizedSymbol(symbol))
    .filter(Boolean)
    .toSorted();
  const active =
    (report?.schema === "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1" &&
      rejectionSummary?.status === "all_candidates_rejected" &&
      latestRejectedSymbols.length > 0) ||
    artifactRejectedSymbols.length > 0;
  const rejectedSymbols = [...new Set([...latestRejectedSymbols, ...artifactRejectedSymbols])]
    .filter(Boolean)
    .toSorted();
  return {
    schema: "openclaw.capital.current-paper-risk-resized-rejection-exclusion.v1",
    status: active ? "active_rejected_candidates_excluded" : "inactive",
    sourceStatus: String(report?.status ?? ""),
    sourceRejectionStatus: String(rejectionSummary?.status ?? ""),
    latestRejectedSymbols: active ? latestRejectedSymbols : [],
    artifactRejectedSymbols: active ? artifactRejectedSymbols : [],
    artifactHistoryStatus: String(artifactHistory?.status ?? ""),
    artifactHistoryCount: safeArray(artifactHistory?.entries).length,
    rejectedSymbols: active ? rejectedSymbols : [],
    noOrderWrite: true,
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
  };
}

function toRepoPath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function pathForReport(repoRoot, filePath) {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replaceAll(path.sep, "/");
  }
  return filePath;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundNumber(value, decimals = 3) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function brokerDeskPriceScaleFor({ event, stockNo }) {
  const instrument = normalizedSymbol(event?.instrument);
  const root = symbolRoot(stockNo);
  if (instrument === "6C" || root === "CD") {
    return 10000;
  }
  return 1;
}

function normalizeBrokerDeskPrice(value, scale) {
  const number = finiteNumber(value);
  if (number === null) {
    return null;
  }
  return scale > 1 ? roundNumber(number / scale, 6) : number;
}

function normalizedSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function isUnsafeTarget(target) {
  return (
    target?.canUseForLiveOrder === true ||
    target?.liveTradingEnabled === true ||
    target?.writeBrokerOrders === true
  );
}

function isFreshAge(ageSeconds, maxFreshSeconds = MAX_FRESH_SECONDS) {
  const age = finiteNumber(ageSeconds);
  const max = finiteNumber(maxFreshSeconds) ?? MAX_FRESH_SECONDS;
  return age !== null && age >= 0 && age <= max;
}

function timestampAgeSeconds(value, nowMs) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function isFreshTimestamp(value, nowMs, maxFreshSeconds = MAX_FRESH_SECONDS) {
  const age = timestampAgeSeconds(value, nowMs);
  const max = finiteNumber(maxFreshSeconds) ?? MAX_FRESH_SECONDS;
  return age !== null && age <= max;
}

function symbolParts(value) {
  const symbol = normalizedSymbol(value);
  if (!symbol) {
    return [];
  }
  const parts = [symbol];
  const commaTail = symbol.includes(",") ? symbol.split(",").at(-1) : "";
  if (commaTail && commaTail !== symbol) {
    parts.push(commaTail);
  }
  return parts;
}

function targetQuoteSymbols(target) {
  const seen = new Set();
  const symbols = [];
  for (const value of [target?.quoteSymbol, ...safeArray(target?.selectedSymbols)]) {
    for (const symbol of symbolParts(value)) {
      if (!symbol || seen.has(symbol)) {
        continue;
      }
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return symbols;
}

function productForTarget(coreMatrix, target) {
  const products = safeArray(coreMatrix?.products);
  if (target?.coreProductId) {
    return products.find((product) => product?.id === target.coreProductId) ?? null;
  }
  const symbol = normalizedSymbol(target?.quoteSymbol);
  return (
    products.find((product) => normalizedSymbol(product?.matchedSymbol) === symbol) ??
    products.find((product) => normalizedSymbol(product?.quote?.stockNo) === symbol) ??
    null
  );
}

function quoteFromCoreProduct(repoRoot, coreMatrixPath, coreMatrix, coreProduct, nowMs) {
  const quote = coreProduct?.quote ?? {};
  const bid = finiteNumber(quote.bid);
  const ask = finiteNumber(quote.ask);
  const close = finiteNumber(quote.close);
  const ageSeconds = finiteNumber(coreProduct?.ageSeconds);
  const maxFreshSeconds = finiteNumber(coreProduct?.maxFreshSeconds) ?? MAX_FRESH_SECONDS;
  const matrixGeneratedAtFresh = isFreshTimestamp(coreMatrix?.generatedAt, nowMs, maxFreshSeconds);
  const quoteReceivedAtFresh = isFreshTimestamp(quote.receivedAt, nowMs, maxFreshSeconds);
  if (
    coreProduct?.ready !== true ||
    coreProduct?.status !== "fresh" ||
    bid === null ||
    ask === null ||
    close === null ||
    !isFreshAge(ageSeconds, maxFreshSeconds) ||
    !matrixGeneratedAtFresh ||
    !quoteReceivedAtFresh
  ) {
    return null;
  }
  return {
    source: "core_product_freshness_matrix",
    sourcePath: toRepoPath(repoRoot, coreMatrixPath),
    receivedAt: quote.receivedAt ?? "",
    eventSource: quote.eventSource ?? "core_product_freshness_matrix",
    stockNo: normalizedSymbol(quote.stockNo || coreProduct.matchedSymbol),
    stockName: String(quote.stockName ?? coreProduct.label ?? ""),
    bid,
    ask,
    close,
    rawBid: quote.raw?.bid,
    rawAsk: quote.raw?.ask,
    rawClose: quote.raw?.close,
    priceScale: quote.priceScale,
    qty: finiteNumber(quote.qty) ?? 0,
    ageSeconds,
    wallClockAgeSeconds: timestampAgeSeconds(quote.receivedAt, nowMs),
    matrixGeneratedAt: coreMatrix?.generatedAt ?? "",
    maxFreshSeconds,
    freshnessStatus: "fresh",
  };
}

function quoteFromDirectQuoteStatus(repoRoot, quoteStatusPath, quoteStatus, target, nowMs) {
  const proof = quoteStatus?.quoteProof ?? {};
  const latestQuote = quoteStatus?.diagnostics?.latestQuote ?? {};
  const targetSymbol = normalizedSymbol(target?.quoteSymbol);
  const proofSymbol = normalizedSymbol(proof.targetStockNo || latestQuote.stockNo);
  const bid = finiteNumber(latestQuote.bid);
  const ask = finiteNumber(latestQuote.ask);
  const close = finiteNumber(latestQuote.close);
  const ageSeconds = finiteNumber(proof.freshnessAgeSeconds);
  const proofMaxFreshSeconds = finiteNumber(proof.maxAllowedFreshAgeSeconds);
  const maxFreshSeconds = Math.min(proofMaxFreshSeconds ?? MAX_FRESH_SECONDS, MAX_FRESH_SECONDS);
  const quoteStatusGeneratedAtFresh = isFreshTimestamp(
    quoteStatus?.generatedAt,
    nowMs,
    maxFreshSeconds,
  );
  const latestQuoteReceivedAtFresh = isFreshTimestamp(
    latestQuote.receivedAt,
    nowMs,
    maxFreshSeconds,
  );
  const fresh =
    quoteStatus?.ready === true ||
    quoteStatus?.status === "ready" ||
    proof.freshnessStatus === "fresh" ||
    proof.freshness === "fresh";
  if (
    targetSymbol.length === 0 ||
    proofSymbol !== targetSymbol ||
    !fresh ||
    bid === null ||
    ask === null ||
    close === null ||
    !isFreshAge(ageSeconds, maxFreshSeconds) ||
    !quoteStatusGeneratedAtFresh ||
    !latestQuoteReceivedAtFresh
  ) {
    return null;
  }
  return {
    source: "direct_quote_status",
    sourcePath: toRepoPath(repoRoot, quoteStatusPath),
    receivedAt: latestQuote.receivedAt ?? "",
    eventSource: latestQuote.eventSource ?? "direct_quote_status",
    stockNo: proofSymbol,
    stockName: String(latestQuote.stockName ?? ""),
    bid,
    ask,
    close,
    qty: finiteNumber(latestQuote.qty) ?? 0,
    ageSeconds,
    wallClockAgeSeconds: timestampAgeSeconds(latestQuote.receivedAt, nowMs),
    quoteStatusGeneratedAt: quoteStatus?.generatedAt ?? "",
    proofMaxFreshSeconds,
    maxFreshSeconds,
    freshnessStatus: "fresh",
  };
}

function brokerDeskQuoteFromEvent({ repoRoot, event, source, sourcePath, nowMs, maxFreshSeconds }) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const stockNo = normalizedSymbol(event.stockNo || event.symbol);
  const priceScale = brokerDeskPriceScaleFor({ event, stockNo });
  const rawBid = finiteNumber(event.bid);
  const rawAsk = finiteNumber(event.ask);
  const rawClose = finiteNumber(event.close ?? event.price);
  const bid = normalizeBrokerDeskPrice(rawBid, priceScale);
  const ask = normalizeBrokerDeskPrice(rawAsk, priceScale);
  const close = normalizeBrokerDeskPrice(rawClose, priceScale);
  const receivedAt = String(event.receivedAt ?? event.time ?? "");
  const wallClockAgeSeconds = timestampAgeSeconds(receivedAt, nowMs);
  if (
    !stockNo ||
    bid === null ||
    ask === null ||
    close === null ||
    bid <= 0 ||
    ask <= 0 ||
    close <= 0 ||
    wallClockAgeSeconds === null ||
    wallClockAgeSeconds > maxFreshSeconds
  ) {
    return null;
  }
  return {
    source,
    sourcePath: pathForReport(repoRoot, sourcePath),
    receivedAt,
    eventSource: String(event.eventSource ?? source),
    stockNo,
    stockName: String(event.stockName ?? event.name ?? ""),
    bid,
    ask,
    close,
    rawBid,
    rawAsk,
    rawClose,
    priceScale,
    qty: finiteNumber(event.qty) ?? 0,
    ageSeconds: wallClockAgeSeconds,
    wallClockAgeSeconds,
    maxFreshSeconds,
    freshnessStatus: "fresh",
  };
}

function quoteFromBrokerDeskState({
  repoRoot,
  latestOsEventPath,
  osSymbolCachePath,
  latestOsEvent,
  osSymbolCache,
  target,
  nowMs,
}) {
  const maxFreshSeconds = MAX_FRESH_SECONDS;
  const targetSymbols = new Set(targetQuoteSymbols(target));
  if (targetSymbols.size === 0) {
    return null;
  }

  const candidates = [];
  const latestOsQuote = brokerDeskQuoteFromEvent({
    repoRoot,
    event: latestOsEvent,
    source: "brokerdesk_latest_os_quote_event",
    sourcePath: latestOsEventPath,
    nowMs,
    maxFreshSeconds,
  });
  if (latestOsQuote && targetSymbols.has(latestOsQuote.stockNo)) {
    candidates.push(latestOsQuote);
  }

  if (isFreshTimestamp(osSymbolCache?.generatedAt, nowMs, maxFreshSeconds)) {
    for (const symbol of targetSymbols) {
      const entry = osSymbolCache?.symbols?.[symbol];
      const cacheQuote = brokerDeskQuoteFromEvent({
        repoRoot,
        event: entry
          ? {
              ...entry,
              receivedAt: entry.time,
              stockNo: entry.symbol,
              stockName: entry.name,
              close: entry.price,
              eventSource: "os_symbol_cache",
            }
          : null,
        source: "brokerdesk_os_symbol_cache",
        sourcePath: osSymbolCachePath,
        nowMs,
        maxFreshSeconds,
      });
      if (cacheQuote) {
        candidates.push(cacheQuote);
      }
    }
  }

  return (
    candidates.toSorted((left, right) => {
      const leftTime = Date.parse(left.receivedAt);
      const rightTime = Date.parse(right.receivedAt);
      return rightTime - leftTime;
    })[0] ?? null
  );
}

function brokerDeskCacheCoverage({
  repoRoot,
  osSymbolCachePath,
  osSymbolCache,
  activeUniverse,
  nowMs,
}) {
  const maxFreshSeconds = MAX_FRESH_SECONDS;
  const entries = Object.values(osSymbolCache?.symbols ?? {});
  const activeTargetsBySymbol = new Map();
  for (const target of activeUniverse) {
    for (const symbol of targetQuoteSymbols(target)) {
      const targets = activeTargetsBySymbol.get(symbol) ?? [];
      targets.push(target);
      activeTargetsBySymbol.set(symbol, targets);
    }
  }
  const freshQuotes = entries
    .map((entry) =>
      brokerDeskQuoteFromEvent({
        repoRoot,
        event: entry
          ? {
              ...entry,
              receivedAt: entry.time,
              stockNo: entry.symbol,
              stockName: entry.name,
              close: entry.price,
              eventSource: "os_symbol_cache",
            }
          : null,
        source: "brokerdesk_os_symbol_cache",
        sourcePath: osSymbolCachePath,
        nowMs,
        maxFreshSeconds,
      }),
    )
    .filter(Boolean)
    .toSorted((left, right) => left.stockNo.localeCompare(right.stockNo));
  const matchedActiveUniverseSymbols = [];
  const eligiblePaperSymbols = [];
  const blockedFreshSymbols = [];
  const unmatchedFreshSymbols = [];
  for (const quote of freshQuotes) {
    const targets = activeTargetsBySymbol.get(quote.stockNo) ?? [];
    if (targets.length === 0) {
      unmatchedFreshSymbols.push(quote.stockNo);
      continue;
    }
    matchedActiveUniverseSymbols.push(quote.stockNo);
    if (targets.some((target) => target?.canGeneratePaperIntent === true)) {
      eligiblePaperSymbols.push(quote.stockNo);
      continue;
    }
    blockedFreshSymbols.push({
      symbol: quote.stockNo,
      targetIds: targets.map((target) => String(target?.id ?? "")).filter(Boolean),
      readiness: targets.map((target) => String(target?.readiness ?? "")).filter(Boolean),
      routeStatus: targets.map((target) => String(target?.routeStatus ?? "")).filter(Boolean),
      quoteReadiness: targets.map((target) => String(target?.quoteReadiness ?? "")).filter(Boolean),
      reason: "fresh_quote_seen_but_target_cannot_generate_paper_intent",
    });
  }
  return {
    schema: "openclaw.capital.brokerdesk-cache-coverage.v1",
    sourcePath: pathForReport(repoRoot, osSymbolCachePath),
    generatedAt: osSymbolCache?.generatedAt ?? "",
    maxFreshSeconds,
    symbolCount: Number(osSymbolCache?.symbolCount ?? entries.length),
    entryCount: entries.length,
    freshWithinMaxSecondsCount: freshQuotes.length,
    staleOrInvalidCount: Math.max(0, entries.length - freshQuotes.length),
    freshSymbols: freshQuotes.map((quote) => quote.stockNo),
    matchedActiveUniverseSymbols: [...new Set(matchedActiveUniverseSymbols)].toSorted(),
    eligiblePaperSymbols: [...new Set(eligiblePaperSymbols)].toSorted(),
    blockedFreshSymbols,
    unmatchedFreshSymbols,
    noBrokerApiCalled: true,
  };
}

function selectQuoteSource({
  repoRoot,
  target,
  coreMatrix,
  coreMatrixPath,
  quoteStatus,
  quoteStatusPath,
  latestOsEvent,
  latestOsEventPath,
  osSymbolCache,
  osSymbolCachePath,
  nowMs,
}) {
  const coreProduct = productForTarget(coreMatrix, target);
  const coreQuote = quoteFromCoreProduct(repoRoot, coreMatrixPath, coreMatrix, coreProduct, nowMs);
  if (coreQuote) {
    return { quote: coreQuote, coreProduct };
  }
  const directQuote = quoteFromDirectQuoteStatus(
    repoRoot,
    quoteStatusPath,
    quoteStatus,
    target,
    nowMs,
  );
  if (directQuote) {
    return { quote: directQuote, coreProduct };
  }
  const brokerDeskQuote = quoteFromBrokerDeskState({
    repoRoot,
    latestOsEventPath,
    osSymbolCachePath,
    latestOsEvent,
    osSymbolCache,
    target,
    nowMs,
  });
  if (brokerDeskQuote) {
    return { quote: brokerDeskQuote, coreProduct };
  }
  return { quote: null, coreProduct };
}

function strategyForTarget(target) {
  const families = new Set(safeArray(target?.strategyFamilies));
  if (families.has("breakout")) {
    return "capital_breakout_fresh_quote_probe";
  }
  if (families.has("vwap_reversion")) {
    return "capital_vwap_reversion_fresh_quote_probe";
  }
  if (families.has("mean_reversion")) {
    return "capital_mean_reversion_fresh_quote_probe";
  }
  return "capital_trend_following_fresh_quote_probe";
}

function roundConfidence(value) {
  return Math.round(value * 1000) / 1000;
}

function confidenceForIntent({ target, quote, routeReady, spread }) {
  let confidence = routeReady ? 0.55 : 0.35;
  const wallClockAgeSeconds = finiteNumber(quote?.wallClockAgeSeconds ?? quote?.ageSeconds);
  if (routeReady) {
    if (wallClockAgeSeconds !== null && wallClockAgeSeconds <= 90) {
      confidence += 0.03;
    } else if (wallClockAgeSeconds !== null && wallClockAgeSeconds <= 180) {
      confidence += 0.015;
    } else if (wallClockAgeSeconds !== null && wallClockAgeSeconds > 240) {
      confidence -= 0.015;
    }
  }
  const close = Math.max(1, Math.abs(finiteNumber(quote?.close) ?? 1));
  const spreadRatio = spread / close;
  if (spreadRatio <= 0.0003) {
    confidence += 0.015;
  } else if (spreadRatio >= 0.0015) {
    confidence -= 0.02;
  }
  if (target?.readiness === "ready_for_current_paper_intent") {
    confidence += 0.01;
  }
  const lowerBound = routeReady ? 0.5 : 0.3;
  return roundConfidence(Math.min(0.66, Math.max(lowerBound, confidence)));
}

function buildTailRiskControls({
  target,
  quote,
  routeReady,
  spread,
  riskPts,
  rewardPts,
  riskNotional,
  contractRisk,
  confidence,
  priceDecimals,
}) {
  const close = Math.max(1, Math.abs(finiteNumber(quote?.close) ?? 1));
  const spreadRatio = spread / close;
  const wallClockAgeSeconds = finiteNumber(quote?.wallClockAgeSeconds ?? quote?.ageSeconds);
  const minRiskPts = finiteNumber(contractRisk?.minRiskPts) ?? 1;
  const knownPointValue = contractRisk?.currency !== "POINT" && contractRisk?.pointValue > 0;
  const checks = {
    routeReady,
    freshQuote:
      quote?.freshnessStatus === "fresh" &&
      wallClockAgeSeconds !== null &&
      wallClockAgeSeconds <= MAX_FRESH_SECONDS,
    knownPointValue,
    spreadRatioWithinLimit: spreadRatio <= TAIL_CONTROL_MAX_SPREAD_RATIO,
    riskNotionalWithinLimit: riskNotional > 0 && riskNotional <= TAIL_CONTROL_MAX_RISK_NOTIONAL,
    confidenceWithinLimit: confidence >= TAIL_CONTROL_MIN_CONFIDENCE,
    rewardRiskSufficient: rewardPts > riskPts && rewardPts / Math.max(riskPts, minRiskPts) >= 1.5,
    paperOnly: true,
  };
  const enabled = Object.values(checks).every((value) => value === true);
  const blockedReasons = Object.entries(checks)
    .filter(([, pass]) => pass !== true)
    .map(([key]) => key);
  const minPositiveExitPts = roundNumber(Math.max(minRiskPts * 0.1, riskPts * 0.05), priceDecimals);
  return {
    schema: "openclaw.capital.paper-tail-risk-controls.v1",
    status: enabled ? "enabled" : "blocked_quality_filter",
    model: "breakeven_time_stop_trailing_target_paper_v1",
    enabled,
    checks,
    blockedReasons,
    maxSpreadRatio: TAIL_CONTROL_MAX_SPREAD_RATIO,
    maxRiskNotional: TAIL_CONTROL_MAX_RISK_NOTIONAL,
    minConfidence: TAIL_CONTROL_MIN_CONFIDENCE,
    fillRateAssumption: TAIL_CONTROL_FILL_RATE_ASSUMPTION,
    stopToScratchRate: TAIL_CONTROL_STOP_TO_SCRATCH_RATE,
    minPositiveExitPts,
    stopPolicy: "move_stop_to_breakeven_after_half_r_then_time_stop",
    exitPolicy: "protective_scratch_or_partial_target_before_stop",
    simulationOnly: true,
    paperOnly: true,
    noLiveOrderSent: true,
  };
}

function symbolRoot(value) {
  return normalizedSymbol(value).replace(/[0-9].*$/u, "");
}

function contractRiskSpecFor({ target, quote }) {
  const symbol = normalizedSymbol(quote?.stockNo || target?.quoteSymbol);
  const marketCode = normalizedSymbol(target?.marketCode);
  const root = symbolRoot(symbol);
  const spec = CONTRACT_RISK_SPECS.find((candidate) =>
    candidate.roots.some(
      (candidateRoot) =>
        root === candidateRoot || marketCode === candidateRoot || symbol.startsWith(candidateRoot),
    ),
  );
  if (spec) {
    return {
      pointValue: spec.pointValue,
      currency: spec.currency,
      source: "openclaw_static_contract_point_value_proxy_v1",
      confidence: spec.confidence,
      minRiskPts: spec.minRiskPts ?? 1,
      priceDecimals: spec.priceDecimals ?? 3,
    };
  }
  return {
    pointValue: 1,
    currency: "POINT",
    source: "unknown_contract_point_value_default_1",
    confidence: "low",
    minRiskPts: 1,
    priceDecimals: 3,
  };
}

function buildIntent({ target, quote, generatedAt, intentRunId }) {
  const entryPrice = quote.bid;
  const strategy = strategyForTarget(target);
  const contractRisk = contractRiskSpecFor({ target, quote });
  const priceDecimals = contractRisk.priceDecimals ?? 3;
  const minimumRiskPts = contractRisk.minRiskPts ?? 1;
  const spread = Math.max(minimumRiskPts, Math.abs(quote.ask - quote.bid));
  const riskPts = Math.max(minimumRiskPts, roundNumber(spread * 4, priceDecimals));
  const rewardPts = roundNumber(riskPts * 2, priceDecimals);
  const riskNotional = roundNumber(riskPts * contractRisk.pointValue);
  const rewardNotional = roundNumber(rewardPts * contractRisk.pointValue);
  const intentSeed = [
    intentRunId,
    target.id,
    quote.stockNo,
    strategy,
    quote.receivedAt,
    entryPrice,
  ].join("|");
  const intentId = `capital-current-paper-${target.id}-${sha256Text(intentSeed).slice(0, 16)}`;
  const routeReady = target.canGeneratePaperIntent === true;
  const confidence = confidenceForIntent({ target, quote, routeReady, spread });
  const tailRiskControls = buildTailRiskControls({
    target,
    quote,
    routeReady,
    spread,
    riskPts,
    rewardPts,
    riskNotional,
    contractRisk,
    confidence,
    priceDecimals,
  });
  return {
    schema: INTENT_SCHEMA,
    intentId,
    intentRunId,
    generatedAt,
    source: "target_registry_current_paper_intents",
    targetId: target.id,
    marketCode: target.marketCode ?? "",
    routingMode: target.routingMode ?? "",
    coreProductId: target.coreProductId ?? "",
    symbol: quote.stockNo || normalizedSymbol(target.quoteSymbol),
    stockName: quote.stockName,
    strategyName: strategy,
    strategy,
    side: "buy",
    direction: "long",
    qty: 1,
    price: entryPrice,
    entryPrice,
    targetPrice: roundNumber(entryPrice + rewardPts, priceDecimals),
    stopPrice: roundNumber(entryPrice - riskPts, priceDecimals),
    stopLoss: roundNumber(entryPrice - riskPts, priceDecimals),
    takeProfit: roundNumber(entryPrice + rewardPts, priceDecimals),
    riskPts,
    rewardPts,
    riskUnit: "quote_points",
    rewardUnit: "quote_points",
    pointValue: contractRisk.pointValue,
    pointValueCurrency: contractRisk.currency,
    pointValueSource: contractRisk.source,
    pointValueConfidence: contractRisk.confidence,
    riskNotional,
    rewardNotional,
    riskCurrency: contractRisk.currency,
    riskTWD: contractRisk.currency === "TWD" ? riskNotional : 0,
    rewardTWD: contractRisk.currency === "TWD" ? rewardNotional : 0,
    riskRewardRatio: 2,
    confidence,
    reason: routeReady
      ? "fresh quote matched targetRegistry route; paper-only current intent generated with freshness/spread confidence."
      : "fresh quote exists but route/promotion is blocked; paper-only exploratory intent generated for simulation evidence only.",
    paperOnly: true,
    executionEligible: routeReady,
    resolverReady: routeReady,
    routeReady,
    historicalSnapshot: false,
    promotionBlocked: !routeReady,
    paperExplorationOnly: !routeReady,
    allowLiveTrading: false,
    liveTradingEnabled: false,
    writeBrokerOrders: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    promoteLiveAuto: false,
    promoteLiveAutomatically: false,
    sourceEvent: {
      eventSource: quote.eventSource,
      receivedAt: quote.receivedAt,
      close: quote.close,
      bid: quote.bid,
      ask: quote.ask,
      qty: quote.qty,
      freshnessStatus: quote.freshnessStatus,
      ageSeconds: quote.ageSeconds,
      wallClockAgeSeconds: quote.wallClockAgeSeconds,
      maxFreshSeconds: quote.maxFreshSeconds,
      source: quote.source,
      sourcePath: quote.sourcePath,
      rawBid: quote.rawBid,
      rawAsk: quote.rawAsk,
      rawClose: quote.rawClose,
      priceScale: quote.priceScale,
    },
    meta: {
      targetReadiness: target.readiness ?? "",
      routeStatus: target.routeStatus ?? "",
      quoteReadiness: target.quoteReadiness ?? "",
      liveEvidenceStatus: target.liveEvidenceStatus ?? "",
      sourceBlocker: target.sourceBlocker ?? "",
      canGeneratePaperIntent: target.canGeneratePaperIntent === true,
      canUseForLiveOrder: false,
      noLiveOrderSent: true,
      confidenceInputs: {
        routeReady,
        wallClockAgeSeconds: quote.wallClockAgeSeconds,
        spread,
        spreadRatio: Math.round((spread / Math.max(1, Math.abs(quote.close))) * 1000000) / 1000000,
      },
      contractRisk,
      tailRiskControls,
    },
  };
}

function classifyTarget({
  target,
  quote,
  coreProduct,
  hasReadyPaperTargets,
  riskResizedRejectedSymbols,
}) {
  const symbol = normalizedSymbol(target?.quoteSymbol);
  if (isUnsafeTarget(target)) {
    return "rejected_unsafe_target_flags";
  }
  if (INVALID_LEGACY_SYMBOLS.has(symbol)) {
    return "rejected_legacy_session_alias";
  }
  if (riskResizedRejectedSymbols?.has(symbol)) {
    return "rejected_risk_resized_same_case_failed";
  }
  const routeResolvedWithFreshBrokerDeskQuote =
    target?.routeStatus === "resolved" &&
    quote?.source &&
    String(quote.source).startsWith("brokerdesk_");
  if (!CANDIDATE_READINESS.has(target?.readiness) && !routeResolvedWithFreshBrokerDeskQuote) {
    return "rejected_not_current_paper_candidate";
  }
  if (!quote) {
    return coreProduct ? "rejected_missing_fresh_price" : "rejected_missing_price_source";
  }
  if (target?.canGeneratePaperIntent !== true && hasReadyPaperTargets) {
    return "rejected_fresh_price_route_blocked";
  }
  return "intent_written";
}

function buildLineDigest(intents) {
  const text = intents.map((intent) => JSON.stringify(intent)).join("\n");
  return text ? sha256Text(`${text}\n`) : "";
}

export async function buildCapitalCurrentPaperIntentsFromTargetRegistry(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const platformReportPath = path.join(
    stateRoot,
    "openclaw-capital-direct-strategy-platform-gate-latest.json",
  );
  const coreMatrixPath = path.join(
    repoRoot,
    ".openclaw",
    "quote",
    "capital-core-product-freshness-matrix.json",
  );
  const quoteStatusPath = path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
  const brokerDeskStateDir = resolveCapitalHftStateDir();
  const latestOsEventPath = path.join(brokerDeskStateDir, "os_latest_quote_event.json");
  const osSymbolCachePath = path.join(brokerDeskStateDir, "os_symbol_cache.json");
  const activeIntentsPath = path.join(tradingRoot, "capital-paper-intents.jsonl");
  const generatedIntentsPath = path.join(
    tradingRoot,
    "capital-current-paper-intents-from-target-registry.jsonl",
  );
  const riskResizedArtifactDir = path.join(tradingRoot, "capital-risk-resized-paper-rerun");
  const riskResizedReportPath = path.join(
    stateRoot,
    "openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
  );
  const panelPath = path.join(
    tradingRoot,
    "capital-current-paper-intents-from-target-registry.json",
  );
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-current-paper-intents-from-target-registry-latest.json",
  );

  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const platformReportOverride =
    options.platformReport && typeof options.platformReport === "object"
      ? options.platformReport
      : null;
  const riskResizedReportOverride =
    options.riskResizedReport && typeof options.riskResizedReport === "object"
      ? options.riskResizedReport
      : null;
  const [
    platformReportFromState,
    coreMatrix,
    quoteStatus,
    latestOsEvent,
    osSymbolCache,
    riskResizedReportFromState,
  ] = await Promise.all([
    platformReportOverride ? null : readJsonIfExists(platformReportPath),
    readJsonIfExists(coreMatrixPath),
    readJsonIfExists(quoteStatusPath),
    readJsonIfExists(latestOsEventPath),
    readJsonIfExists(osSymbolCachePath),
    riskResizedReportOverride ? null : readJsonIfExists(riskResizedReportPath),
  ]);
  const platformReport = platformReportOverride ?? platformReportFromState;
  const riskResizedReport = riskResizedReportOverride ?? riskResizedReportFromState;
  const riskResizedArtifactHistory =
    await buildRiskResizedArtifactRejectionHistory(riskResizedArtifactDir);
  const riskResizedRejectionExclusion = buildRiskResizedRejectionExclusion(
    riskResizedReport,
    riskResizedArtifactHistory,
  );
  const riskResizedRejectedSymbols = new Set(riskResizedRejectionExclusion.rejectedSymbols ?? []);
  const platformReportSource = platformReportOverride
    ? "current_cycle_platform_report"
    : "state_file";

  if (!platformReport) {
    const commandSurface = {
      schema: "openclaw.command-surface.repo-root-pnpm.v1",
      repoRoot,
      currentCheckCommand: openclawPnpmCommand(
        repoRoot,
        "capital:trade:current-paper-intents:check",
      ),
      refreshPlatformCommand: openclawPnpmCommand(repoRoot, "capital:trade:platform:check"),
      noPkgManifestAvoided: true,
    };
    return {
      schema: SCHEMA,
      generatedAt,
      status: "blocked_platform_report_missing",
      repoRoot,
      source: {
        platformReportPath: toRepoPath(repoRoot, platformReportPath),
        platformReportExists: false,
        platformReportSource,
        coreMatrixPath: toRepoPath(repoRoot, coreMatrixPath),
        quoteStatusPath: toRepoPath(repoRoot, quoteStatusPath),
        riskResizedReportPath: toRepoPath(repoRoot, riskResizedReportPath),
        riskResizedReportExists: riskResizedReport !== null,
        riskResizedArtifactDir: toRepoPath(repoRoot, riskResizedArtifactDir),
        brokerDeskStateDir,
        latestOsEventPath: pathForReport(repoRoot, latestOsEventPath),
        osSymbolCachePath: pathForReport(repoRoot, osSymbolCachePath),
        latestOsEventExists: latestOsEvent !== null,
        osSymbolCacheExists: osSymbolCache !== null,
        noBrokerApiCalled: true,
      },
      targetRegistry: {
        scope: "",
        activeUniverseCount: 0,
        candidateTargetCount: 0,
        generatedIntentCount: 0,
      },
      intentWrite: {
        activeIntentsPath: toRepoPath(repoRoot, activeIntentsPath),
        generatedIntentsPath: toRepoPath(repoRoot, generatedIntentsPath),
        activeIntentsRecordCount: 0,
        generatedPaperIntentsOnly: true,
      },
      safety: {
        paperOnly: true,
        noLiveOrderSent: true,
        sentOrder: false,
        liveTradingEnabled: false,
        writeBrokerOrders: false,
        brokerWriteAttempted: false,
      },
      blockers: ["platform_report_missing"],
      paths: { reportPath, panelPath, activeIntentsPath, generatedIntentsPath },
      commandSurface,
      nextSafeTask: qualifyOpenClawPnpmCommands(
        repoRoot,
        "先執行 pnpm capital:trade:platform:check 產生策略平台報告，再重跑 pnpm capital:trade:current-paper-intents:check。",
      ),
    };
  }

  const activeUniverse = safeArray(platformReport.strategyPlatform?.targetRegistry?.activeUniverse);
  const brokerDeskCacheCoverageReport = brokerDeskCacheCoverage({
    repoRoot,
    osSymbolCachePath,
    osSymbolCache,
    activeUniverse,
    nowMs,
  });
  const runSeed = `${generatedAt}|${platformReport.generatedAt ?? ""}|${activeUniverse.length}`;
  const intentRunId = `capital-current-paper-intents-${sha256Text(runSeed).slice(0, 16)}`;
  const targetResults = [];
  const intents = [];
  const hasReadyPaperTargets = activeUniverse.some(
    (target) => target?.canGeneratePaperIntent === true,
  );
  let exploratoryIntentSkippedCount = 0;

  for (const target of activeUniverse) {
    const { quote, coreProduct } = selectQuoteSource({
      repoRoot,
      target,
      coreMatrix,
      coreMatrixPath,
      quoteStatus,
      quoteStatusPath,
      latestOsEvent,
      latestOsEventPath,
      osSymbolCache,
      osSymbolCachePath,
      nowMs,
    });
    const classification = classifyTarget({
      target,
      quote,
      coreProduct,
      hasReadyPaperTargets,
      riskResizedRejectedSymbols,
    });
    if (classification === "intent_written") {
      if (target.canGeneratePaperIntent === true || !hasReadyPaperTargets) {
        intents.push(buildIntent({ target, quote, generatedAt, intentRunId }));
      } else {
        exploratoryIntentSkippedCount += 1;
      }
    }
    targetResults.push({
      id: target.id ?? "",
      symbol: normalizedSymbol(target.quoteSymbol),
      readiness: target.readiness ?? "",
      routeStatus: target.routeStatus ?? "",
      quoteReadiness: target.quoteReadiness ?? "",
      coreProductId: target.coreProductId ?? "",
      quoteSource: quote?.source ?? "",
      quoteFreshness: quote?.freshnessStatus ?? "",
      quoteAgeSeconds: quote?.ageSeconds ?? null,
      quoteWallClockAgeSeconds: quote?.wallClockAgeSeconds ?? null,
      quoteMaxFreshSeconds: quote?.maxFreshSeconds ?? null,
      classification,
      riskResizedRejected: riskResizedRejectedSymbols.has(normalizedSymbol(target.quoteSymbol)),
      paperOnly: true,
      canGeneratePaperIntent: target.canGeneratePaperIntent === true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
    });
  }

  const activeIntentLines = intents.map((intent) => JSON.stringify(intent));
  const activeIntentText = activeIntentLines.length ? `${activeIntentLines.join("\n")}\n` : "";
  const sourceDigest = buildLineDigest(intents);
  const nextSafeTask =
    intents.length > 0
      ? "重跑 pnpm capital:paper-hft:fill-simulation && pnpm capital:paper-hft:evaluate && pnpm capital:trade:platform:check，確認 no_current_paper_intents 已清除；仍不得送真單。"
      : "等待 fresh priced target callback 後重跑 pnpm capital:trade:current-paper-intents:check；仍不得送真單。";
  const commandSurface = {
    schema: "openclaw.command-surface.repo-root-pnpm.v1",
    repoRoot,
    currentCheckCommand: openclawPnpmCommand(repoRoot, "capital:trade:current-paper-intents:check"),
    refreshCoreProductsCommand: openclawPnpmCommand(repoRoot, "capital:quote:core-products:check"),
    refreshPaperIntentsCommand: openclawPnpmCommand(
      repoRoot,
      "capital:trade:current-paper-intents",
    ),
    noPkgManifestAvoided: true,
  };

  const report = {
    schema: SCHEMA,
    generatedAt,
    status: intents.length > 0 ? "current_paper_intents_written" : "blocked_no_fresh_price_targets",
    repoRoot,
    source: {
      platformReportPath: toRepoPath(repoRoot, platformReportPath),
      platformReportExists: true,
      platformReportSource,
      platformReportSchema: platformReport.schema ?? "",
      platformReportStatus: platformReport.status ?? "",
      coreMatrixPath: toRepoPath(repoRoot, coreMatrixPath),
      coreMatrixExists: coreMatrix !== null,
      quoteStatusPath: toRepoPath(repoRoot, quoteStatusPath),
      quoteStatusExists: quoteStatus !== null,
      riskResizedReportPath: toRepoPath(repoRoot, riskResizedReportPath),
      riskResizedReportExists: riskResizedReport !== null,
      riskResizedArtifactDir: toRepoPath(repoRoot, riskResizedArtifactDir),
      riskResizedArtifactHistoryStatus: riskResizedArtifactHistory.status,
      brokerDeskStateDir,
      latestOsEventPath: pathForReport(repoRoot, latestOsEventPath),
      latestOsEventExists: latestOsEvent !== null,
      latestOsEventStockNo: normalizedSymbol(latestOsEvent?.stockNo),
      latestOsEventReceivedAt: latestOsEvent?.receivedAt ?? "",
      osSymbolCachePath: pathForReport(repoRoot, osSymbolCachePath),
      osSymbolCacheExists: osSymbolCache !== null,
      osSymbolCacheGeneratedAt: osSymbolCache?.generatedAt ?? "",
      osSymbolCacheSymbolCount: Number(osSymbolCache?.symbolCount ?? 0),
      noBrokerApiCalled: true,
    },
    targetRegistry: {
      scope: platformReport.strategyPlatform?.targetRegistry?.scope ?? "",
      activeUniverseCount: activeUniverse.length,
      candidateTargetCount: targetResults.filter((target) =>
        [
          "intent_written",
          "rejected_missing_fresh_price",
          "rejected_missing_price_source",
        ].includes(target.classification),
      ).length,
      generatedIntentCount: intents.length,
      executionReadyIntentCount: intents.filter((intent) => intent.routeReady === true).length,
      exploratoryIntentSkippedCount,
      riskResizedRejectedCount: targetResults.filter((target) => target.riskResizedRejected).length,
      riskResizedRejectionExclusion,
      writtenTargetIds: intents.map((intent) => intent.targetId),
      brokerDeskCacheCoverage: brokerDeskCacheCoverageReport,
      targetResults,
    },
    intentWrite: {
      activeIntentsPath: toRepoPath(repoRoot, activeIntentsPath),
      generatedIntentsPath: toRepoPath(repoRoot, generatedIntentsPath),
      activeIntentsRecordCount: intents.length,
      generatedPaperIntentsOnly: true,
      intentRunId,
      sourceDigest,
    },
    safety: {
      paperOnly: true,
      noLiveOrderSent: true,
      no_live_order_sent: true,
      sentOrder: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      brokerWriteAttempted: false,
      promoteLiveAutomatically: false,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
    },
    blockers:
      intents.length > 0
        ? ["paper_intents_generated_but_live_promotion_still_blocked"]
        : ["no_fresh_priced_targets_for_current_paper_intents"],
    paths: {
      reportPath,
      panelPath,
      activeIntentsPath,
      generatedIntentsPath,
    },
    commandSurface,
    nextSafeTask: qualifyOpenClawPnpmCommands(repoRoot, nextSafeTask),
  };

  return { report, activeIntentText };
}

export async function writeCapitalCurrentPaperIntentsState(result) {
  const report = result.report ?? result;
  const activeIntentText = result.activeIntentText ?? "";
  await writeTextWithSha(report.paths.activeIntentsPath, activeIntentText);
  await writeTextWithSha(report.paths.generatedIntentsPath, activeIntentText);
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildCapitalCurrentPaperIntentsFromTargetRegistry({
    repoRoot: process.cwd(),
  });
  const report = result.report ?? result;
  const activeIntentText = result.activeIntentText ?? "";

  if (options.writeState || options.check) {
    await writeCapitalCurrentPaperIntentsState({ report, activeIntentText });
  }

  if (options.check) {
    if (!ALLOWED_STATUSES.has(report.status)) {
      throw new Error(`CAPITAL_CURRENT_PAPER_INTENTS_STATUS_INVALID=${report.status}`);
    }
    if (
      report.safety?.noLiveOrderSent !== true ||
      report.safety?.sentOrder !== false ||
      report.safety?.writeBrokerOrders !== false ||
      report.safety?.liveTradingEnabled !== false ||
      report.intentWrite?.generatedPaperIntentsOnly !== true
    ) {
      throw new Error("CAPITAL_CURRENT_PAPER_INTENTS_SAFETY_MISMATCH");
    }
  }

  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_CURRENT_PAPER_INTENTS=${report.status} intents=${report.intentWrite.activeIntentsRecordCount} noLiveOrderSent=${report.safety.noLiveOrderSent}\n`,
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
