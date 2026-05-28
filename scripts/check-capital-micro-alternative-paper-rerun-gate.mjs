#!/usr/bin/env node
// Verifies the paper-only micro/low-notional Capital alternative rerun gate.
import { buildMicroAlternativePaperRerunGate } from "./openclaw-capital-micro-alternative-paper-rerun-gate.mjs";

const result = await buildMicroAlternativePaperRerunGate({ repoRoot: process.cwd() });
const issues = [];

if (result.schema !== "openclaw.capital.micro-alternative-paper-rerun-gate.v1") {
  issues.push(`schema=${result.schema ?? ""}`);
}

if (
  ![
    "micro_alternative_candidate_tail_passed_requires_promotion_rerun",
    "micro_alternative_rerun_completed_still_blocked",
    "blocked_no_micro_alternative_ready",
  ].includes(result.status)
) {
  issues.push(`status=${result.status ?? ""}`);
}

if (
  result.safetyLock?.paperOnly !== true ||
  result.safetyLock?.simulatedOnly !== true ||
  result.safetyLock?.liveTradingEnabled !== false ||
  result.safetyLock?.writeBrokerOrders !== false ||
  result.safetyLock?.sentOrder !== false ||
  result.safetyLock?.noLiveOrderSent !== true ||
  result.noOrderWrite !== true
) {
  issues.push(`safety=${JSON.stringify(result.safetyLock)}`);
}

if (
  typeof result.candidateCount !== "number" ||
  typeof result.passCount !== "number" ||
  typeof result.blockedCount !== "number" ||
  !Array.isArray(result.blockers) ||
  !Array.isArray(result.candidates) ||
  !Array.isArray(result.reruns) ||
  !Array.isArray(result.source?.allowedSymbols) ||
  !String(result.machineLine ?? "").includes("microAlternativePaperRerun=") ||
  !String(result.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push("shape=invalid");
}

for (const candidate of result.candidates ?? []) {
  if (
    candidate.noOrderWrite !== true ||
    !["MCL0000", "QM0000"].includes(candidate.symbol) ||
    candidate.marketGroup !== "energy" ||
    typeof candidate.riskNotional !== "number" ||
    candidate.riskNotional > result.source.maxRiskNotional ||
    !String(candidate.intentPath ?? "").includes("capital-micro-alternative-paper-rerun/")
  ) {
    issues.push(`candidate=${JSON.stringify(candidate)}`);
  }
}

for (const rerun of result.reruns ?? []) {
  if (
    !["micro_alternative_tail_passed", "micro_alternative_tail_still_blocked"].includes(
      rerun.status,
    ) ||
    rerun.safetyLock?.writeBrokerOrders !== false ||
    rerun.safetyLock?.sentOrder !== false ||
    rerun.safetyLock?.noLiveOrderSent !== true ||
    rerun.noOrderWrite !== true ||
    typeof rerun.p05TotalPnlPts !== "number" ||
    typeof rerun.p05TotalPnlNotional !== "number"
  ) {
    issues.push(`rerun=${JSON.stringify(rerun)}`);
  }
}

if (result.candidateCount > 0 && result.reruns.length !== result.candidateCount) {
  issues.push(`rerunCount=${result.reruns.length};candidateCount=${result.candidateCount}`);
}

if (
  result.status === "micro_alternative_candidate_tail_passed_requires_promotion_rerun" &&
  result.passCount <= 0
) {
  issues.push("passCount=0");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_MICRO_ALTERNATIVE_PAPER_RERUN_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_MICRO_ALTERNATIVE_PAPER_RERUN_CHECK=OK status=${result.status} candidates=${result.candidateCount} pass=${result.passCount} noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
