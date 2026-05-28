#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  RESOLVER_EVIDENCE_LOCK_REPORT_REL,
  RESOLVER_EVIDENCE_LOCK_SCHEMA,
} from "./openclaw-resolver-evidence-lock.mjs";

const REQUIRED_PACKAGE_SCRIPTS = {
  "autonomous:resolver-evidence-lock": "scripts/openclaw-resolver-evidence-lock.mjs",
  "autonomous:resolver-evidence-lock:check": "scripts/check-openclaw-resolver-evidence-lock.mjs",
  "check:openclaw-resolver-evidence-lock": "scripts/check-openclaw-resolver-evidence-lock.mjs",
};

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

async function main() {
  const repoRoot = process.cwd();
  const reportPath = path.join(repoRoot, RESOLVER_EVIDENCE_LOCK_REPORT_REL);
  const report = await readJson(reportPath);
  const packageJson = await readJson(path.join(repoRoot, "package.json"));

  assertPackageScripts(packageJson);
  assertCondition(report.schema === RESOLVER_EVIDENCE_LOCK_SCHEMA, "schema mismatch");
  assertCondition(report.mode === "same_case_rerun_evidence_lock", "mode mismatch");
  assertCondition(report.candidateId === "same-case-rerun-evidence-lock", "candidate id mismatch");
  assertCondition(report.status === "evidence_locked", "evidence must be locked");
  assertCondition(report.errorCode === "OK", "errorCode must be OK");
  assertCondition(
    report.safety?.runtimeMutationAllowed === false,
    "runtime mutation must be false",
  );
  assertCondition(report.safety?.externalWriteAllowed === false, "external write must be false");
  assertCondition(report.safety?.autoExecuteAllowed === false, "auto execute must be false");
  assertCondition(report.safety?.liveTradingAllowed === false, "live trading must be false");
  assertCondition(Array.isArray(report.safetyFailures), "safety failures must be an array");
  assertCondition(report.safetyFailures.length === 0, "safety failures must be empty");
  assertCondition(Array.isArray(report.commands), "commands must be an array");
  assertCondition(report.commands.length >= 2, "same-case commands missing");
  for (const command of report.commands) {
    assertCondition(command.allowed === true, `command not allowlisted: ${command.command}`);
    assertCondition(command.exitCode === 0, `command failed: ${command.command}`);
  }
  assertCondition(report.summary?.evidenceComplete === true, "evidence must be complete");
  assertCondition(report.summary?.promotionAllowed === false, "promotion must remain blocked");
  assertCondition(
    report.promotionGate?.status === "blocked_p0_p1_open",
    "promotion gate must block on open P0/P1",
  );
  assertCondition(
    Array.isArray(report.promotionGate?.openP0P1Candidates) &&
      report.promotionGate.openP0P1Candidates.length > 0,
    "open P0/P1 candidates must be recorded",
  );
  assertCondition(report.nextSafeTask?.id === "weak-signal-intake-gate", "next safe task mismatch");

  process.stdout.write("OPENCLAW_RESOLVER_EVIDENCE_LOCK_CHECK=OK\n");
}

main().catch((error) => {
  process.stderr.write(
    `OPENCLAW_RESOLVER_EVIDENCE_LOCK_CHECK=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
