#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-public-strategy-research-loop-latest.json",
);

const issues = [];
let report;

try {
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.public-strategy-research-loop.v1") {
    issues.push(`schema=${report.schema}`);
  }
  if (
    !["blocked_tail_risk_research_loop_ready", "ready_for_paper_promotion_review"].includes(
      report.status,
    )
  ) {
    issues.push(`status=${report.status}`);
  }
  if (report.publicSourceCount < 5 || report.discussionSourceCount < 1) {
    issues.push(`sourceCoverage=${report.publicSourceCount}/${report.discussionSourceCount}`);
  }
  if (!Array.isArray(report.loopSteps) || report.loopSteps.length < 4) {
    issues.push("loopSteps missing");
  }
  for (const step of report.loopSteps ?? []) {
    if (step.noOrderWrite !== true) {
      issues.push(`loopStep noOrderWrite mismatch: ${step.id ?? "unknown"}`);
    }
  }
  if (
    report.safetyLock?.paperOnly !== true ||
    report.safetyLock?.liveTradingEnabled !== false ||
    report.safetyLock?.writeBrokerOrders !== false ||
    report.safetyLock?.brokerWriteAttempted !== false ||
    report.safetyLock?.sentOrder !== false ||
    report.safetyLock?.noLiveOrderSent !== true ||
    report.safetyLock?.noOrderWrite !== true
  ) {
    issues.push(`safety=${JSON.stringify(report.safetyLock)}`);
  }
  const learningPacket = report.learningPacket ?? {};
  if (learningPacket.schema !== "openclaw.capital.public-strategy-learning-packet.v1") {
    issues.push(`learningPacket.schema=${learningPacket.schema ?? ""}`);
  }
  if (
    learningPacket.liveApprovalGranted !== false ||
    learningPacket.discussionSourcesAreHypothesisOnly !== true ||
    learningPacket.noExternalSourceCanAuthorizeLiveOrders !== true
  ) {
    issues.push("learning guard mismatch");
  }
  for (const update of learningPacket.candidateUpdates ?? []) {
    if (update.approvedLive !== false || update.noOrderWrite !== true) {
      issues.push(`candidate update safety mismatch: ${update.strategyId ?? "unknown"}`);
    }
    if (typeof update.validationCommand !== "string" || !update.validationCommand) {
      issues.push(`candidate update validation missing: ${update.strategyId ?? "unknown"}`);
    }
  }
  const tailRiskBlocker = report.tailRiskBlocker ?? {};
  if (tailRiskBlocker.schema !== "openclaw.capital.public-strategy-tail-risk-blocker-summary.v1") {
    issues.push(`tailRiskBlocker.schema=${tailRiskBlocker.schema ?? ""}`);
  }
  if (tailRiskBlocker.noOrderWrite !== true || tailRiskBlocker.noLiveOrderSent !== true) {
    issues.push("tailRiskBlocker safety mismatch");
  }
  if (
    typeof tailRiskBlocker.nextRepairCommand !== "string" ||
    !tailRiskBlocker.nextRepairCommand.startsWith("pnpm ")
  ) {
    issues.push(`tailRiskBlocker.nextRepairCommand=${tailRiskBlocker.nextRepairCommand ?? ""}`);
  }
  if (
    typeof tailRiskBlocker.followUpCommand !== "string" ||
    !tailRiskBlocker.followUpCommand.startsWith("pnpm ")
  ) {
    issues.push(`tailRiskBlocker.followUpCommand=${tailRiskBlocker.followUpCommand ?? ""}`);
  }
  if (
    !Array.isArray(tailRiskBlocker.requiredEvidence) ||
    tailRiskBlocker.requiredEvidence.length < 1
  ) {
    issues.push("tailRiskBlocker.requiredEvidence missing");
  }
  if (typeof report.nextCommand !== "string" || !report.nextCommand.startsWith("pnpm ")) {
    issues.push(`nextCommand=${report.nextCommand ?? ""}`);
  }
  if (!report.paths?.reportPath || !report.paths?.markdownPath) {
    issues.push("paths missing");
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_PUBLIC_STRATEGY_RESEARCH_LOOP_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `CAPITAL_PUBLIC_STRATEGY_RESEARCH_LOOP_CHECK=OK status=${report.status} candidates=${report.candidateCount} next=${report.nextCommand} noOrderWrite=${report.safetyLock.noOrderWrite}\n`,
);
