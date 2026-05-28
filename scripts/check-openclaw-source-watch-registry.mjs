#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  SOURCE_WATCH_REGISTRY_REPORT_REL,
  SOURCE_WATCH_REGISTRY_SCHEMA,
} from "./openclaw-source-watch-registry.mjs";

const REQUIRED_SOURCE_IDS = new Set([
  "official-openclaw-site",
  "github-openclaw-org",
  "github-openclaw-issues",
  "github-openclaw-discussions",
  "reddit-openclaw",
  "third-party-openclaw-sites",
]);
const VALID_TRUST_LEVELS = new Set(["high", "medium", "low"]);

function fail(message) {
  process.stderr.write(`OPENCLAW_SOURCE_WATCH_REGISTRY_CHECK=FAIL ${message}\n`);
  process.exitCode = 1;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateSource(source) {
  assertCondition(typeof source.id === "string" && source.id.length > 0, "source id missing");
  assertCondition(REQUIRED_SOURCE_IDS.has(source.id), `unexpected source id: ${source.id}`);
  assertCondition(
    typeof source.sourceType === "string" && source.sourceType.length > 0,
    `source type missing for ${source.id}`,
  );
  assertCondition(
    VALID_TRUST_LEVELS.has(source.trustLevel),
    `invalid trust level for ${source.id}`,
  );
  assertCondition(source.publicAccessOnly === true, `source must stay public-only: ${source.id}`);
  assertCondition(source.loginRequired === false, `source must not require login: ${source.id}`);
  assertCondition(
    source.externalWriteAllowed === false,
    `source must not allow external writes: ${source.id}`,
  );
  assertCondition(
    source.privateGroupAllowed === false,
    `source must not allow private group access: ${source.id}`,
  );
  assertCondition(
    source.autoResolverAllowed === false,
    `source must not directly auto-resolve: ${source.id}`,
  );
  assertCondition(
    typeof source.dedupeKey === "string" && source.dedupeKey.length > 0,
    `dedupe key missing for ${source.id}`,
  );
  assertCondition(
    typeof source.candidateOutput === "string" && source.candidateOutput.length > 0,
    `candidate output missing for ${source.id}`,
  );
}

async function main() {
  const repoRoot = process.cwd();
  const reportPath = path.join(repoRoot, SOURCE_WATCH_REGISTRY_REPORT_REL);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));

  assertCondition(report.schema === SOURCE_WATCH_REGISTRY_SCHEMA, "schema mismatch");
  assertCondition(report.mode === "dry_run", "registry must stay dry_run");
  assertCondition(report.safety?.dryRunOnly === true, "dryRunOnly must be true");
  assertCondition(report.safety?.networkFetchPerformed === false, "network fetch must be false");
  assertCondition(report.safety?.externalWriteAllowed === false, "external write must be false");
  assertCondition(report.safety?.loginAttempted === false, "login attempted must be false");
  assertCondition(Array.isArray(report.sources), "sources must be an array");
  assertCondition(report.sources.length === REQUIRED_SOURCE_IDS.size, "source count mismatch");

  for (const source of report.sources) {
    validateSource(source);
  }

  const foundIds = new Set(report.sources.map((source) => source.id));
  for (const requiredId of REQUIRED_SOURCE_IDS) {
    assertCondition(foundIds.has(requiredId), `missing source: ${requiredId}`);
  }

  assertCondition(
    report.summary?.totalSources === report.sources.length,
    "summary totalSources mismatch",
  );
  assertCondition(
    report.summary?.trustedSourceCount >= 2,
    "expected at least two trusted official sources",
  );
  assertCondition(
    report.summary?.needsConfirmationSources >= 3,
    "expected weak or discussion sources to require confirmation",
  );
  assertCondition(
    report.nextSafeTask?.id === "cron-watch-source-check",
    "next safe task must be cron-watch-source-check",
  );

  process.stdout.write("OPENCLAW_SOURCE_WATCH_REGISTRY_CHECK=OK\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
