#!/usr/bin/env node
// Verifies the paper-only opposite-exposure rerun gate.
import {
  buildOppositeExposurePaperRerunGate,
  writeOppositeExposurePaperRerunGate,
} from "./openclaw-capital-opposite-exposure-paper-rerun-gate.mjs";

const result = await buildOppositeExposurePaperRerunGate({ repoRoot: process.cwd() });
await writeOppositeExposurePaperRerunGate(result);
const issues = [];

if (result.schema !== "openclaw.capital.opposite-exposure-paper-rerun-gate.v1") {
  issues.push(`schema=${result.schema ?? ""}`);
}

if (
  ![
    "opposite_exposure_tail_passed_requires_promotion_rerun",
    "opposite_exposure_rerun_completed_still_blocked",
    "blocked_no_opposite_exposure_batch",
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
  typeof result.selectedCandidateCount !== "number" ||
  typeof result.rerunIntentCount !== "number" ||
  typeof result.passCount !== "number" ||
  typeof result.blockedCount !== "number" ||
  !Array.isArray(result.blockers) ||
  !Array.isArray(result.candidates) ||
  !String(result.machineLine ?? "").includes("oppositeExposurePaperRerun=") ||
  !String(result.machineLine ?? "").includes("oppositeRiskReview=") ||
  !String(result.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push("shape=invalid");
}

if (
  result.riskReview?.schema !== "openclaw.capital.opposite-exposure-risk-review.v1" ||
  !["blocked_no_rerun", "requires_paper_risk_resizing_review", "clear"].includes(
    result.riskReview?.status,
  ) ||
  typeof result.riskReview?.candidateCount !== "number" ||
  typeof result.riskReview?.overMaxRiskCount !== "number" ||
  typeof result.riskReview?.actionableCandidateCount !== "number" ||
  !Array.isArray(result.riskReview?.candidates) ||
  !Array.isArray(result.riskReview?.requiredEvidence) ||
  result.riskReview?.requiredEvidence.length < 4 ||
  result.riskReview?.safetyLock?.writeBrokerOrders !== false ||
  result.riskReview?.safetyLock?.sentOrder !== false ||
  result.riskReview?.safetyLock?.noLiveOrderSent !== true ||
  result.riskReview?.noOrderWrite !== true ||
  !String(result.riskReview?.machineLine ?? "").includes("oppositeRiskReview=") ||
  !String(result.riskReview?.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push(`riskReview=${JSON.stringify(result.riskReview)}`);
}

for (const candidate of result.riskReview?.candidates ?? []) {
  if (
    candidate.noOrderWrite !== true ||
    typeof candidate.symbol !== "string" ||
    !["boolean"].includes(typeof candidate.overMaxRisk)
  ) {
    issues.push(`riskReview.candidate=${JSON.stringify(candidate)}`);
  }
}

if (
  result.riskReview?.status === "requires_paper_risk_resizing_review" &&
  result.riskReview?.actionableCandidateCount > 0 &&
  result.nextCommand?.command !== "pnpm capital:strategy:risk-resized-paper-rerun:check"
) {
  issues.push(`nextCommand=${JSON.stringify(result.nextCommand)}`);
}

for (const candidate of result.candidates ?? []) {
  const originalSide = String(candidate.originalSide ?? "").toLowerCase();
  const side = String(candidate.side ?? "").toLowerCase();
  const originalDirection = String(candidate.originalDirection ?? "").toLowerCase();
  const direction = String(candidate.direction ?? "").toLowerCase();
  const sideOpposite =
    (originalSide === "buy" && side === "sell") || (originalSide === "sell" && side === "buy");
  const directionOpposite =
    (originalDirection === "long" && direction === "short") ||
    (originalDirection === "short" && direction === "long");
  if (
    candidate.noOrderWrite !== true ||
    candidate.freshResolved !== true ||
    candidate.knownPointValue !== true ||
    candidate.oppositeExposure !== true ||
    sideOpposite !== true ||
    directionOpposite !== true
  ) {
    issues.push(`candidate=${JSON.stringify(candidate)}`);
  }
}

if (result.rerun) {
  if (
    !["opposite_exposure_tail_passed", "opposite_exposure_tail_still_blocked"].includes(
      result.rerun.status,
    ) ||
    result.rerun.safetyLock?.writeBrokerOrders !== false ||
    result.rerun.safetyLock?.sentOrder !== false ||
    result.rerun.safetyLock?.noLiveOrderSent !== true ||
    result.rerun.noOrderWrite !== true ||
    typeof result.rerun.p05TotalPnlPts !== "number" ||
    typeof result.rerun.p05TotalPnlNotional !== "number"
  ) {
    issues.push(`rerun=${JSON.stringify(result.rerun)}`);
  }
}

if (result.rerunIntentCount > 0 && !result.rerun) {
  issues.push("rerun missing");
}

if (
  result.status === "opposite_exposure_tail_passed_requires_promotion_rerun" &&
  result.passCount <= 0
) {
  issues.push("passCount=0");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_OPPOSITE_EXPOSURE_PAPER_RERUN_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_OPPOSITE_EXPOSURE_PAPER_RERUN_CHECK=OK status=${result.status} candidates=${result.rerunIntentCount} pass=${result.passCount} noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
