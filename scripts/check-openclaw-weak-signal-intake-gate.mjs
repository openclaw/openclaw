#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
  WEAK_SIGNAL_INTAKE_GATE_SCHEMA,
} from "./openclaw-weak-signal-intake-gate.mjs";

const REQUIRED_WEAK_SIGNAL_IDS = new Set([
  "github-openclaw-discussions",
  "reddit-openclaw",
  "third-party-openclaw-sites",
]);

const REQUIRED_PACKAGE_SCRIPTS = {
  "autonomous:weak-signal-intake-gate": "scripts/openclaw-weak-signal-intake-gate.mjs",
  "autonomous:weak-signal-intake-gate:check": "scripts/check-openclaw-weak-signal-intake-gate.mjs",
  "check:openclaw-weak-signal-intake-gate": "scripts/check-openclaw-weak-signal-intake-gate.mjs",
};

function fail(message) {
  process.stderr.write(`OPENCLAW_WEAK_SIGNAL_INTAKE_GATE_CHECK=FAIL ${message}\n`);
  process.exitCode = 1;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

function assertPackageScripts(packageJson) {
  for (const [scriptName, token] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    const value = packageJson.scripts?.[scriptName];
    assertCondition(
      typeof value === "string" && value.includes(token),
      `package script ${scriptName} must include ${token}`,
    );
  }
}

function validateWeakSignal(signal) {
  assertCondition(
    REQUIRED_WEAK_SIGNAL_IDS.has(signal.sourceId),
    `unexpected weak signal ${signal.sourceId}`,
  );
  assertCondition(
    signal.candidateOutput === "needs_confirmation",
    `weak signal must stay needs_confirmation: ${signal.sourceId}`,
  );
  assertCondition(
    signal.requiresConfirmation === true,
    `weak signal must require confirmation: ${signal.sourceId}`,
  );
  assertCondition(
    signal.autoResolverAllowed === false,
    `weak signal must not auto resolve: ${signal.sourceId}`,
  );
  assertCondition(
    signal.runtimePatchAllowed === false,
    `weak signal must not patch runtime: ${signal.sourceId}`,
  );
  assertCondition(
    signal.decision === "needs_confirmation_locked",
    `weak signal decision mismatch: ${signal.sourceId}`,
  );
  assertCondition(
    Array.isArray(signal.unsafeReasons) && signal.unsafeReasons.length === 0,
    `weak signal has unsafe reasons: ${signal.sourceId}`,
  );
}

async function main() {
  const repoRoot = process.cwd();
  const report = await readJson(path.join(repoRoot, WEAK_SIGNAL_INTAKE_GATE_REPORT_REL));
  const packageJson = await readJson(path.join(repoRoot, "package.json"));
  const weakSignals = Array.isArray(report.weakSignals) ? report.weakSignals : [];
  const weakSignalIds = new Set(weakSignals.map((signal) => signal.sourceId));

  assertPackageScripts(packageJson);
  assertCondition(report.schema === WEAK_SIGNAL_INTAKE_GATE_SCHEMA, "schema mismatch");
  assertCondition(report.mode === "dry_run", "report must stay dry_run");
  assertCondition(
    report.status === "pass_needs_confirmation_locked",
    "status must lock needs-confirmation",
  );
  assertCondition(report.safety?.dryRunOnly === true, "dryRunOnly must be true");
  assertCondition(
    report.safety?.runtimeMutationAllowed === false,
    "runtime mutation must be false",
  );
  assertCondition(report.safety?.externalWriteAllowed === false, "external write must be false");
  assertCondition(report.safety?.autoExecuteAllowed === false, "auto execute must be false");
  assertCondition(report.safety?.liveTradingAllowed === false, "live trading must be false");
  assertCondition(report.safety?.networkFetchPerformed === false, "network fetch must be false");
  assertCondition(report.safety?.loginAttempted === false, "login must be false");
  assertCondition(
    report.rules?.allowWeakSignalResolverCandidate === false,
    "weak signal resolver promotion must be false",
  );
  assertCondition(
    report.rules?.allowWeakSignalRuntimePatch === false,
    "weak signal runtime patch must be false",
  );
  assertCondition(report.summary?.sourceRegistryPresent === true, "source registry missing");
  assertCondition(
    report.summary?.weakSignals === weakSignals.length,
    "weak signal summary mismatch",
  );
  assertCondition(
    report.summary?.weakSignals >= REQUIRED_WEAK_SIGNAL_IDS.size,
    "weak signal count too low",
  );
  assertCondition(
    report.summary?.unsafeWeakPromotions === 0,
    "unsafe weak promotions must be zero",
  );
  assertCondition(report.summary?.promotionAllowed === false, "promotion must not be allowed");

  for (const requiredId of REQUIRED_WEAK_SIGNAL_IDS) {
    assertCondition(weakSignalIds.has(requiredId), `missing weak signal ${requiredId}`);
  }
  for (const signal of weakSignals) {
    validateWeakSignal(signal);
  }

  assertCondition(
    Array.isArray(report.confirmedResolverSources) && report.confirmedResolverSources.length >= 1,
    "expected at least one confirmed resolver source",
  );
  assertCondition(
    Array.isArray(report.blockedPromotions) &&
      report.blockedPromotions.length === weakSignals.length,
    "blocked promotions must match weak signals",
  );
  assertCondition(report.nextSafeTask?.id === "cron-watch-source-check", "next safe task mismatch");

  process.stdout.write("OPENCLAW_WEAK_SIGNAL_INTAKE_GATE_CHECK=OK\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
