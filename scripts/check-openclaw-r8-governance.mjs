#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configPath = resolve(root, "config/openclaw-unified-governance-r8.1.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expect(condition, errors, message) {
  if (!condition) {
    errors.push(message);
  }
}

function expectNumberInRange(value, min, max, errors, label) {
  expect(
    typeof value === "number" && Number.isFinite(value),
    errors,
    `${label} must be a finite number`,
  );
  if (typeof value === "number" && Number.isFinite(value)) {
    expect(value >= min && value <= max, errors, `${label} must be between ${min} and ${max}`);
  }
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  fail(
    `[R8] Failed to read or parse config: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const errors = [];

expect(config.version === "R8.1", errors, "version must be R8.1");
expect(isObject(config.scope), errors, "scope must be an object");
expect(isObject(config.principles), errors, "principles must be an object");
expect(isObject(config.gates), errors, "gates must be an object");
expect(isObject(config.validationThresholds), errors, "validationThresholds must be an object");
expect(isObject(config.r8DetectionTargets), errors, "r8DetectionTargets must be an object");
expect(isObject(config.sccp), errors, "sccp must be an object");
expect(Array.isArray(config.outputContract), errors, "outputContract must be an array");

if (isObject(config.scope)) {
  expect(Array.isArray(config.scope.appliesTo), errors, "scope.appliesTo must be an array");
  expect(config.scope.sharedDecisionCore === true, errors, "scope.sharedDecisionCore must be true");
}

if (isObject(config.principles)) {
  const boolKeys = [
    "fullModuleBlueprintBeforeTickets",
    "singleTicketExecutionAfterBlueprint",
    "simulateBeforeComplete",
    "immediateFixAndSameCaseRerun",
    "evidenceLockRequired",
    "p0p1MustBeZero",
  ];
  for (const key of boolKeys) {
    expect(config.principles[key] === true, errors, `principles.${key} must be true`);
  }
}

if (isObject(config.gates)) {
  expect(isObject(config.gates.fmbg), errors, "gates.fmbg must be an object");
  expect(isObject(config.gates.vfc), errors, "gates.vfc must be an object");
  expect(isObject(config.gates.release), errors, "gates.release must be an object");
}

if (isObject(config.gates?.fmbg)) {
  const coverage = config.gates.fmbg.requiredCoveragePct;
  expect(isObject(coverage), errors, "gates.fmbg.requiredCoveragePct must be an object");
  if (isObject(coverage)) {
    const keys = [
      "moduleCoverage",
      "dependencyCoverage",
      "contractCoverage",
      "testMappingCoverage",
      "rollbackMappingCoverage",
    ];
    for (const key of keys) {
      expect(coverage[key] === 100, errors, `gates.fmbg.requiredCoveragePct.${key} must be 100`);
    }
  }
  expect(
    Array.isArray(config.gates.fmbg.requiredFields) && config.gates.fmbg.requiredFields.length >= 9,
    errors,
    "gates.fmbg.requiredFields must list at least 9 fields",
  );
}

if (isObject(config.validationThresholds)) {
  expect(
    config.validationThresholds.ruleUpgradeSimulationRuns >= 500,
    errors,
    "validationThresholds.ruleUpgradeSimulationRuns must be >= 500",
  );
  expectNumberInRange(
    config.validationThresholds.maxFailRatePct,
    0,
    100,
    errors,
    "validationThresholds.maxFailRatePct",
  );
  expectNumberInRange(
    config.validationThresholds.maxEscapeRatePct,
    0,
    100,
    errors,
    "validationThresholds.maxEscapeRatePct",
  );
  expectNumberInRange(
    config.validationThresholds.maxRolloutIncidentPct,
    0,
    100,
    errors,
    "validationThresholds.maxRolloutIncidentPct",
  );
  expectNumberInRange(
    config.validationThresholds.maxFlakyFalseBlockPct,
    0,
    100,
    errors,
    "validationThresholds.maxFlakyFalseBlockPct",
  );
}

if (isObject(config.r8DetectionTargets)) {
  const targetKeys = [
    "d0",
    "d1",
    "d2",
    "flakyContainment",
    "architectureDetection",
    "asvsL1",
    "asvsL2",
    "asvsL3",
    "canaryDetection",
    "evidenceCoverage",
  ];
  for (const key of targetKeys) {
    expectNumberInRange(config.r8DetectionTargets[key], 0, 1, errors, `r8DetectionTargets.${key}`);
  }
}

if (isObject(config.sccp)) {
  expect(config.sccp.enabled === true, errors, "sccp.enabled must be true");
  expect(
    config.sccp.policy === "shortest_correct_code",
    errors,
    "sccp.policy must be shortest_correct_code",
  );
  expect(
    config.sccp.mustPreserveMaintainability === true,
    errors,
    "sccp.mustPreserveMaintainability must be true",
  );
}

const requiredOutputs = [
  "core_result",
  "files_changed",
  "validation_result",
  "error_fix_result",
  "remaining_blockers",
  "risk",
  "rollback_path",
  "next_safe_task",
];
for (const key of requiredOutputs) {
  expect(config.outputContract?.includes?.(key), errors, `outputContract must include ${key}`);
}

if (errors.length > 0) {
  process.stderr.write("[R8] Governance check failed:\n");
  for (const error of errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.exit(2);
}

const summary = {
  status: "pass",
  version: config.version,
  appliesTo: config.scope.appliesTo,
  simulationRuns: config.validationThresholds.ruleUpgradeSimulationRuns,
  thresholds: {
    maxFailRatePct: config.validationThresholds.maxFailRatePct,
    maxEscapeRatePct: config.validationThresholds.maxEscapeRatePct,
    maxRolloutIncidentPct: config.validationThresholds.maxRolloutIncidentPct,
    maxFlakyFalseBlockPct: config.validationThresholds.maxFlakyFalseBlockPct,
  },
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(
    `[R8] PASS version=${summary.version} appliesTo=${summary.appliesTo.join(",")} runs=${summary.simulationRuns}\n`,
  );
}
