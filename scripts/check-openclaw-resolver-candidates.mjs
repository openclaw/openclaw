#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  RESOLVER_CANDIDATES_REPORT_REL,
  RESOLVER_CANDIDATES_SCHEMA,
} from "./openclaw-resolver-candidates.mjs";

const REQUIRED_CANDIDATE_FIELDS = [
  "id",
  "status",
  "priority",
  "blocker",
  "sourceEvidence",
  "risk",
  "proposedCommand",
  "sameCaseRerun",
  "rollbackPath",
];
const VALID_CANDIDATE_STATUSES = new Set(["ready_for_review", "completed"]);

function fail(message) {
  process.stderr.write(`OPENCLAW_RESOLVER_CANDIDATES_CHECK=FAIL ${message}\n`);
  process.exitCode = 1;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateCandidate(candidate) {
  for (const field of REQUIRED_CANDIDATE_FIELDS) {
    assertCondition(candidate[field] !== undefined, `candidate missing ${field}`);
  }
  assertCondition(
    VALID_CANDIDATE_STATUSES.has(candidate.status),
    `candidate status mismatch: ${candidate.id}`,
  );
  assertCondition(candidate.priority === "P1", `candidate priority must be P1: ${candidate.id}`);
  assertCondition(
    typeof candidate.blocker?.id === "string" && candidate.blocker.id.length > 0,
    `candidate blocker id missing: ${candidate.id}`,
  );
  assertCondition(
    Array.isArray(candidate.sourceEvidence) && candidate.sourceEvidence.length >= 2,
    `candidate source evidence incomplete: ${candidate.id}`,
  );
  assertCondition(
    candidate.risk?.runtimeMutationAllowed === false,
    "runtime mutation must be false",
  );
  assertCondition(candidate.risk?.externalWriteAllowed === false, "external write must be false");
  assertCondition(candidate.risk?.liveTradingAllowed === false, "live trading must be false");
  assertCondition(
    candidate.risk?.requiresHumanReviewBeforeApply === true,
    "human review before apply must be true",
  );
  assertCondition(
    candidate.proposedCommand?.mode === "planned_only",
    "command must be planned_only",
  );
  assertCondition(candidate.proposedCommand?.allowlisted === true, "command must be allowlisted");
  assertCondition(candidate.proposedCommand?.autoExecute === false, "autoExecute must be false");
  assertCondition(candidate.sameCaseRerun?.required === true, "same-case rerun must be required");
  assertCondition(
    Array.isArray(candidate.sameCaseRerun?.commands) &&
      candidate.sameCaseRerun.commands.length >= 2,
    "same-case rerun commands missing",
  );
  assertCondition(
    Array.isArray(candidate.rollbackPath) && candidate.rollbackPath.length >= 3,
    "rollback missing",
  );
}

async function main() {
  const repoRoot = process.cwd();
  const reportPath = path.join(repoRoot, RESOLVER_CANDIDATES_REPORT_REL);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));

  assertCondition(report.schema === RESOLVER_CANDIDATES_SCHEMA, "schema mismatch");
  assertCondition(report.mode === "dry_run", "report must stay dry_run");
  assertCondition(report.safety?.dryRunOnly === true, "dryRunOnly must be true");
  assertCondition(
    report.safety?.runtimeMutationAllowed === false,
    "runtime mutation must be false",
  );
  assertCondition(report.safety?.externalWriteAllowed === false, "external write must be false");
  assertCondition(report.safety?.autoExecuteAllowed === false, "auto execute must be false");
  assertCondition(report.safety?.liveTradingAllowed === false, "live trading must be false");
  assertCondition(Array.isArray(report.candidates), "candidates must be an array");
  assertCondition(report.candidates.length >= 1, "at least one candidate required");
  const candidateIds = new Set(report.candidates.map((candidate) => candidate.id));

  for (const candidate of report.candidates) {
    validateCandidate(candidate);
  }

  assertCondition(
    report.summary?.totalCandidates === report.candidates.length,
    "summary totalCandidates mismatch",
  );
  assertCondition(report.summary?.autoExecutable === 0, "candidates must not be auto executable");
  assertCondition(candidateIds.has("weak-signal-intake-gate"), "weak-signal candidate missing");
  assertCondition(candidateIds.has("cron-watch-source-check"), "cron-watch candidate missing");
  const weakSignalCandidate = report.candidates.find(
    (candidate) => candidate.id === "weak-signal-intake-gate",
  );
  assertCondition(
    weakSignalCandidate?.status === "completed",
    "weak-signal candidate must be completed",
  );
  assertCondition(report.nextSafeTask?.id === "cron-watch-source-check", "next safe task mismatch");

  process.stdout.write("OPENCLAW_RESOLVER_CANDIDATES_CHECK=OK\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
