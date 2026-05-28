#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-current-paper-intents-from-target-registry-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "current_paper_intents_written",
  "blocked_no_fresh_price_targets",
  "blocked_platform_report_missing",
]);
const INVALID_LEGACY_SYMBOLS = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);
const TREASURY_POINT_VALUE_BY_ROOT = new Map([
  ["TU", 2000],
  ["ZT", 2000],
  ["FV", 1000],
  ["ZF", 1000],
  ["TY", 1000],
  ["ZN", 1000],
  ["TN", 1000],
  ["US", 1000],
  ["ZB", 1000],
  ["UB", 1000],
]);
const ENERGY_POINT_VALUE_BY_ROOT = new Map([
  ["BZ", 1000],
  ["CL", 1000],
  ["QM", 500],
  ["MCL", 100],
  ["RB", 42000],
]);
const FX_POINT_VALUE_BY_ROOT = new Map([["CD", 100000]]);

function normalizedSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function symbolRoot(value) {
  return normalizedSymbol(value).replace(/\d+$/u, "");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const issues = [];
let report;
try {
  report = await readJson(REPORT_PATH);
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.current-paper-intents-from-target-registry.v1") {
    issues.push("schema mismatch");
  }
  if (!ALLOWED_STATUSES.has(report.status)) {
    issues.push(`status=${report.status}`);
  }
  if (report.source?.noBrokerApiCalled !== true) {
    issues.push("noBrokerApiCalled must be true");
  }
  if (report.targetRegistry?.scope !== "all_registered_capital_futures_routes") {
    issues.push("targetRegistry scope mismatch");
  }
  if ((report.targetRegistry?.activeUniverseCount ?? 0) < 5) {
    issues.push("active universe too small");
  }
  const brokerDeskCoverage = report.targetRegistry?.brokerDeskCacheCoverage;
  if (
    report.status !== "blocked_platform_report_missing" &&
    (brokerDeskCoverage?.schema !== "openclaw.capital.brokerdesk-cache-coverage.v1" ||
      brokerDeskCoverage?.noBrokerApiCalled !== true ||
      typeof brokerDeskCoverage?.symbolCount !== "number" ||
      typeof brokerDeskCoverage?.entryCount !== "number" ||
      typeof brokerDeskCoverage?.freshWithinMaxSecondsCount !== "number" ||
      typeof brokerDeskCoverage?.staleOrInvalidCount !== "number" ||
      !Array.isArray(brokerDeskCoverage?.freshSymbols) ||
      !Array.isArray(brokerDeskCoverage?.matchedActiveUniverseSymbols) ||
      !Array.isArray(brokerDeskCoverage?.eligiblePaperSymbols) ||
      !Array.isArray(brokerDeskCoverage?.blockedFreshSymbols) ||
      !Array.isArray(brokerDeskCoverage?.unmatchedFreshSymbols))
  ) {
    issues.push("brokerDeskCacheCoverage shape mismatch");
  }
  if (report.intentWrite?.activeIntentsPath !== ".openclaw/trading/capital-paper-intents.jsonl") {
    issues.push("active intents path mismatch");
  }
  if (report.intentWrite?.generatedPaperIntentsOnly !== true) {
    issues.push("generatedPaperIntentsOnly must be true");
  }
  const riskResizedExclusion = report.targetRegistry?.riskResizedRejectionExclusion;
  if (
    riskResizedExclusion &&
    (riskResizedExclusion.schema !==
      "openclaw.capital.current-paper-risk-resized-rejection-exclusion.v1" ||
      riskResizedExclusion.noOrderWrite !== true ||
      riskResizedExclusion.safetyLock?.noLiveOrderSent !== true ||
      !Array.isArray(riskResizedExclusion.rejectedSymbols))
  ) {
    issues.push("riskResizedRejectionExclusion shape mismatch");
  }
  if (
    report.safety?.paperOnly !== true ||
    report.safety?.noLiveOrderSent !== true ||
    report.safety?.sentOrder !== false ||
    report.safety?.writeBrokerOrders !== false ||
    report.safety?.liveTradingEnabled !== false
  ) {
    issues.push("safety lock mismatch");
  }
  if (
    report.commandSurface?.schema !== "openclaw.command-surface.repo-root-pnpm.v1" ||
    report.commandSurface?.repoRoot !== process.cwd() ||
    report.commandSurface?.currentCheckCommand !==
      openclawPnpmCommand(process.cwd(), "capital:trade:current-paper-intents:check") ||
    report.commandSurface?.noPkgManifestAvoided !== true ||
    !String(report.nextSafeTask ?? "").includes(`pnpm --dir ${process.cwd()}`)
  ) {
    issues.push(`commandSurface=${JSON.stringify(report.commandSurface ?? null)}`);
  }

  const activePath = path.join(process.cwd(), report.intentWrite?.activeIntentsPath ?? "");
  const generatedPath = path.join(process.cwd(), report.intentWrite?.generatedIntentsPath ?? "");
  let intents = [];
  let generatedIntents = [];
  try {
    intents = await readJsonl(activePath);
  } catch (error) {
    issues.push(
      `active intents read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    generatedIntents = await readJsonl(generatedPath);
  } catch (error) {
    issues.push(
      `generated intents read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const reportIntentCount = report.intentWrite?.activeIntentsRecordCount ?? -1;
  const activeScrubbedButGeneratedIntact =
    intents.length === 0 && generatedIntents.length === reportIntentCount && reportIntentCount > 0;
  const validationIntents = activeScrubbedButGeneratedIntact ? generatedIntents : intents;

  if (intents.length !== reportIntentCount && !activeScrubbedButGeneratedIntact) {
    issues.push(
      `active intents count mismatch report=${report.intentWrite?.activeIntentsRecordCount} file=${intents.length}`,
    );
  }
  if (generatedIntents.length !== reportIntentCount) {
    issues.push(
      `generated intents count mismatch report=${report.intentWrite?.activeIntentsRecordCount} file=${generatedIntents.length}`,
    );
  }
  if (report.status === "current_paper_intents_written" && validationIntents.length <= 0) {
    issues.push("status written but no active intents");
  }
  const readyTargetCount = (report.targetRegistry?.targetResults ?? []).filter(
    (target) => target?.canGeneratePaperIntent === true,
  ).length;
  const targetResults = report.targetRegistry?.targetResults ?? [];
  const riskResizedRejectedSymbols = new Set(
    riskResizedExclusion?.status === "active_rejected_candidates_excluded"
      ? (riskResizedExclusion?.rejectedSymbols ?? []).map((symbol) => normalizedSymbol(symbol))
      : [],
  );
  const riskResizedRejectedTargetCount = targetResults.filter((target) =>
    riskResizedRejectedSymbols.has(normalizedSymbol(target?.symbol)),
  ).length;
  if (
    riskResizedRejectedSymbols.size > 0 &&
    (report.targetRegistry?.riskResizedRejectedCount ?? 0) !== riskResizedRejectedTargetCount
  ) {
    issues.push("riskResizedRejectedCount does not match rejected target coverage");
  }
  const leakedRiskResizedIntents = validationIntents.filter((intent) =>
    riskResizedRejectedSymbols.has(normalizedSymbol(intent.symbol)),
  );
  if (leakedRiskResizedIntents.length > 0) {
    issues.push(
      `risk-resized rejected symbols leaked into active intents symbols=${leakedRiskResizedIntents
        .map((intent) => intent.symbol)
        .join("|")}`,
    );
  }
  for (const target of targetResults) {
    if (!riskResizedRejectedSymbols.has(normalizedSymbol(target?.symbol))) {
      continue;
    }
    if (target?.classification === "intent_written") {
      issues.push(`risk-resized rejected target classified as written target=${target.id}`);
    }
    if (target?.riskResizedRejected !== true) {
      issues.push(`risk-resized rejected target missing flag target=${target.id}`);
    }
  }
  for (const target of targetResults) {
    if (
      readyTargetCount > 0 &&
      target?.classification === "intent_written" &&
      target?.canGeneratePaperIntent !== true
    ) {
      issues.push(`intent_written target is not paper eligible target=${target.id}`);
    }
  }
  for (const blockedFresh of brokerDeskCoverage?.blockedFreshSymbols ?? []) {
    const blockedSymbols = new Set(
      (blockedFresh?.targetIds ?? []).map((targetId) => String(targetId)),
    );
    const leakedWrittenTargets = targetResults.filter(
      (target) =>
        blockedSymbols.has(String(target.id ?? "")) && target.classification === "intent_written",
    );
    if (leakedWrittenTargets.length > 0) {
      issues.push(
        `blocked fresh symbol classified as written symbol=${blockedFresh.symbol} targets=${leakedWrittenTargets
          .map((target) => target.id)
          .join("|")}`,
      );
    }
  }
  for (const target of report.targetRegistry?.targetResults ?? []) {
    if (
      target?.quoteSource === "direct_quote_status" &&
      Number(target?.quoteMaxFreshSeconds ?? 0) > 300
    ) {
      issues.push(
        `direct quote strategy freshness too wide target=${target.id} max=${target.quoteMaxFreshSeconds}`,
      );
    }
  }
  const exploratoryIntentCount = validationIntents.filter(
    (intent) => intent.meta?.canGeneratePaperIntent !== true,
  ).length;
  if (readyTargetCount > 0 && exploratoryIntentCount > 0) {
    issues.push(
      `route-ready batch contains exploratory intents readyTargets=${readyTargetCount} exploratoryIntents=${exploratoryIntentCount}`,
    );
  }
  if (
    readyTargetCount > 0 &&
    report.targetRegistry?.executionReadyIntentCount !==
      report.intentWrite?.activeIntentsRecordCount
  ) {
    issues.push("executionReadyIntentCount must match active intent count when ready routes exist");
  }
  for (const [index, intent] of validationIntents.entries()) {
    const label = `intent[${index}]`;
    if (intent.schema !== "openclaw.capital.paper-intent.v2") {
      issues.push(`${label} schema mismatch`);
    }
    if (intent.paperOnly !== true || intent.historicalSnapshot !== false) {
      issues.push(`${label} must be current paper-only intent`);
    }
    if (intent.meta?.canGeneratePaperIntent === true) {
      if (
        intent.routeReady !== true ||
        intent.resolverReady !== true ||
        intent.executionEligible !== true ||
        intent.promotionBlocked !== false ||
        intent.paperExplorationOnly !== false
      ) {
        issues.push(`${label} route-ready paper intent eligibility mismatch`);
      }
    }
    if (
      intent.allowLiveTrading === true ||
      intent.liveTradingEnabled === true ||
      intent.writeBrokerOrders === true ||
      intent.writeTradingEnabled === true ||
      intent.brokerOrderPathEnabled === true ||
      intent.promoteLiveAutomatically === true ||
      intent.promoteLiveAuto === true
    ) {
      issues.push(`${label} has live/write flag enabled`);
    }
    if (
      INVALID_LEGACY_SYMBOLS.has(
        String(intent.symbol ?? "")
          .trim()
          .toUpperCase(),
      )
    ) {
      issues.push(`${label} legacy session alias leaked`);
    }
    if (!intent.sourceEvent || Number.isFinite(Number(intent.sourceEvent.ageSeconds)) !== true) {
      issues.push(`${label} missing fresh quote source event`);
    }
    const wallClockAge = Number(intent.sourceEvent?.wallClockAgeSeconds);
    const maxFreshSeconds = Number(intent.sourceEvent?.maxFreshSeconds ?? 300);
    if (!Number.isFinite(wallClockAge) || wallClockAge > maxFreshSeconds) {
      issues.push(`${label} wall-clock quote freshness exceeded`);
    }
    const treasuryPointValue = TREASURY_POINT_VALUE_BY_ROOT.get(symbolRoot(intent.symbol));
    const energyPointValue = ENERGY_POINT_VALUE_BY_ROOT.get(symbolRoot(intent.symbol));
    const fxPointValue = FX_POINT_VALUE_BY_ROOT.get(symbolRoot(intent.symbol));
    if (treasuryPointValue) {
      if (intent.pointValue !== treasuryPointValue || intent.pointValueCurrency !== "USD") {
        issues.push(
          `${label} treasury point value mismatch symbol=${intent.symbol} pointValue=${intent.pointValue} currency=${intent.pointValueCurrency}`,
        );
      }
      if (
        intent.riskCurrency === "POINT" ||
        intent.pointValueSource === "unknown_contract_point_value_default_1"
      ) {
        issues.push(`${label} treasury contract must not use unknown POINT risk default`);
      }
    }
    if (energyPointValue) {
      if (intent.pointValue !== energyPointValue || intent.pointValueCurrency !== "USD") {
        issues.push(
          `${label} energy point value mismatch symbol=${intent.symbol} pointValue=${intent.pointValue} currency=${intent.pointValueCurrency}`,
        );
      }
      if (
        intent.riskCurrency === "POINT" ||
        intent.pointValueSource === "unknown_contract_point_value_default_1"
      ) {
        issues.push(`${label} energy contract must not use unknown POINT risk default`);
      }
    }
    if (fxPointValue) {
      if (intent.pointValue !== fxPointValue || intent.pointValueCurrency !== "USD") {
        issues.push(
          `${label} fx point value mismatch symbol=${intent.symbol} pointValue=${intent.pointValue} currency=${intent.pointValueCurrency}`,
        );
      }
      if (
        intent.riskCurrency === "POINT" ||
        intent.pointValueSource === "unknown_contract_point_value_default_1"
      ) {
        issues.push(`${label} fx contract must not use unknown POINT risk default`);
      }
      if (
        Number(intent.entryPrice) >= 10 ||
        Number(intent.sourceEvent?.priceScale ?? 1) < 10000 ||
        Number(intent.riskPts) >= 1
      ) {
        issues.push(
          `${label} fx quote scale mismatch symbol=${intent.symbol} entry=${intent.entryPrice} riskPts=${intent.riskPts} scale=${intent.sourceEvent?.priceScale}`,
        );
      }
    }
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_CURRENT_PAPER_INTENTS_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_CURRENT_PAPER_INTENTS_CHECK=OK status=${report.status} intents=${report.intentWrite.activeIntentsRecordCount} targets=${report.targetRegistry.generatedIntentCount}/${report.targetRegistry.activeUniverseCount} noLiveOrderSent=${report.safety.noLiveOrderSent}\n`,
  );
}
