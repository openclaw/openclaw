#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalPublicStrategyIntake } from "./openclaw-capital-public-strategy-intake.mjs";

const SCHEMA = "openclaw.capital.public-strategy-research-loop.v1";

function parseArgs(argv) {
  return {
    repoRoot: valueAfter(argv, "--repo-root") ?? process.cwd(),
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state"),
  };
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeText(filePath, text);
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonOptional(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readyCandidate(candidate) {
  return String(candidate?.decision ?? "").startsWith("ready_");
}

function candidateLearningStatus(candidate) {
  if (readyCandidate(candidate)) return "candidate";
  return "blocked";
}

function buildLoopSteps({ intake, p05, strategyFillGate }) {
  const hasSources = Array.isArray(intake.publicSources) && intake.publicSources.length > 0;
  const hasCandidates =
    Array.isArray(intake.strategyCandidates) && intake.strategyCandidates.length > 0;
  const tailRiskPassed = p05 > 0 && strategyFillGate === "passed";
  return [
    {
      id: "refresh_public_source_catalog",
      status: hasSources ? "passed_static_source_catalog" : "blocked_no_public_sources",
      sourceCount: intake.publicSources?.length ?? 0,
      discussionSourceCount:
        intake.publicSources?.filter((source) => source.kind === "discussion_forum").length ?? 0,
      noOrderWrite: true,
    },
    {
      id: "run_quote_simulation_intake",
      status:
        intake.status === "strategy_candidates_generated" ? "passed" : "blocked_no_intake_report",
      command: "pnpm capital:strategy:public-intake",
      noOrderWrite: true,
    },
    {
      id: "gate_tail_risk",
      status: tailRiskPassed ? "passed" : "blocked_negative_tail_risk",
      command: "pnpm capital:strategy:fill-simulation:check",
      monteCarloP05Pts: p05,
      strategyFillGate,
      noOrderWrite: true,
    },
    {
      id: "publish_paper_research_candidates",
      status: hasCandidates ? "ready_for_paper_research_report" : "blocked_no_candidates",
      candidateCount: intake.strategyCandidates?.length ?? 0,
      command: "pnpm capital:strategy:research-loop:check",
      noOrderWrite: true,
    },
  ];
}

function buildLearningPacket(intake) {
  const candidates = Array.isArray(intake.strategyCandidates) ? intake.strategyCandidates : [];
  return {
    schema: "openclaw.capital.public-strategy-learning-packet.v1",
    registryWriteMode: "report_only_current_repo",
    liveApprovalGranted: false,
    discussionSourcesAreHypothesisOnly: true,
    noExternalSourceCanAuthorizeLiveOrders: true,
    candidateUpdates: candidates.map((candidate) => ({
      strategyId: candidate.id,
      targetStatus: candidateLearningStatus(candidate),
      decision: candidate.decision,
      sourceBasis: candidate.sourceBasis,
      validationCommand: candidate.nextValidationCommand,
      approvedPaper: false,
      approvedLive: false,
      noOrderWrite: true,
      noLiveOrderSent: true,
    })),
  };
}

function buildTailRiskBlockerSummary(tailRiskRepair) {
  const nextCommand = tailRiskRepair?.nextCommand ?? {};
  const promotionDiagnostic = tailRiskRepair?.promotionBlockerDiagnostic ?? {};
  const repairCandidatePlan = tailRiskRepair?.repairCandidatePlan ?? {};
  const empiricalTailEvidence = tailRiskRepair?.empiricalTailEvidence ?? {};
  return {
    schema: "openclaw.capital.public-strategy-tail-risk-blocker-summary.v1",
    status: tailRiskRepair?.status ?? "missing_tail_risk_repair_report",
    promotionGateStatus: tailRiskRepair?.promotionGateStatus ?? "unknown",
    currentP05Pts: numeric(tailRiskRepair?.currentP05Pts),
    currentP05Notional: numeric(tailRiskRepair?.currentP05Notional),
    stopHitRate: numeric(empiricalTailEvidence.stopHitRate),
    requiredStopHitRate: 0.05,
    selectedSymbols: Array.isArray(tailRiskRepair?.selectedSymbols)
      ? tailRiskRepair.selectedSymbols
      : [],
    blockingFactors: Array.isArray(promotionDiagnostic.blockingFactors)
      ? promotionDiagnostic.blockingFactors
      : [],
    candidateGate: {
      positiveTailCandidateCount: numeric(
        promotionDiagnostic.candidateGate?.positiveTailCandidateCount,
      ),
      nextPaperCandidateBatchStatus:
        promotionDiagnostic.candidateGate?.nextPaperCandidateBatchStatus ?? "unknown",
      candidateQualityStatus:
        promotionDiagnostic.candidateGate?.candidateQualityStatus ?? "unknown",
      freshCandidateRefreshPlanStatus:
        promotionDiagnostic.candidateGate?.freshCandidateRefreshPlanStatus ?? "unknown",
      riskNotionalReviewPlanStatus:
        promotionDiagnostic.candidateGate?.riskNotionalReviewPlanStatus ?? "unknown",
    },
    repairCandidatePlanStatus: repairCandidatePlan.status ?? "unknown",
    nextRepairCommand: nextCommand.command ?? "pnpm capital:trade:current-paper-intents",
    validationCommand:
      nextCommand.validationCommand ?? "pnpm capital:trade:current-paper-intents:check",
    followUpCommand: nextCommand.followUpCommand ?? "pnpm capital:strategy:fill-simulation:check",
    requiredEvidence: Array.isArray(nextCommand.requiredEvidence)
      ? nextCommand.requiredEvidence
      : [
          "routeStatus=resolved",
          "wallClockFresh=true",
          "known pointValueCurrency",
          "p05_total_pnl_pts > 0",
        ],
    blockerMachineLine: tailRiskRepair?.machineLine ?? "",
    noOrderWrite: true,
    noLiveOrderSent: true,
  };
}

function buildMarkdown(report) {
  const lines = [
    "# OpenClaw Capital Public Strategy Research Loop",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${report.status}`,
    `nextCommand: ${report.nextCommand}`,
    `noOrderWrite: ${report.safetyLock.noOrderWrite}`,
    "",
    "## Loop Steps",
    "",
  ];
  for (const step of report.loopSteps) {
    lines.push(`- ${step.id}: ${step.status}; noOrderWrite=${step.noOrderWrite}`);
  }
  lines.push("", "## Candidate Updates", "");
  for (const update of report.learningPacket.candidateUpdates) {
    lines.push(
      `- ${update.strategyId}: ${update.targetStatus}; validate=${update.validationCommand}`,
    );
  }
  lines.push("", "## Tail Risk Blocker", "");
  lines.push(
    `- status: ${report.tailRiskBlocker.status}; p05=${report.tailRiskBlocker.currentP05Pts}; stopHitRate=${report.tailRiskBlocker.stopHitRate}`,
  );
  lines.push(`- nextRepairCommand: ${report.tailRiskBlocker.nextRepairCommand}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runCapitalPublicStrategyResearchLoop(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-public-strategy-research-loop-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-public-strategy-research-loop-latest.md",
  );
  const tailRiskRepairPath = path.join(
    stateRoot,
    "openclaw-capital-strategy-tail-risk-repair-latest.json",
  );
  const intake = await runCapitalPublicStrategyIntake({ repoRoot, writeState: true });
  const tailRiskRepair = await readJsonOptional(tailRiskRepairPath, {});
  const p05 = numeric(intake.localEvidence?.monteCarloP05Pts);
  const strategyFillGate = String(intake.localEvidence?.strategyFillGate ?? "unknown");
  const candidates = Array.isArray(intake.strategyCandidates) ? intake.strategyCandidates : [];
  const readyCount = candidates.filter(readyCandidate).length;
  const loopSteps = buildLoopSteps({ intake, p05, strategyFillGate });
  const tailRiskPassed = p05 > 0 && strategyFillGate === "passed";
  const status = tailRiskPassed
    ? "ready_for_paper_promotion_review"
    : "blocked_tail_risk_research_loop_ready";
  const nextCommand = tailRiskPassed
    ? "pnpm capital:trade:auto-cycle:check"
    : "pnpm capital:strategy:fill-simulation:check";
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    status,
    mode: "quote_simulation_public_source_research_loop",
    publicSourceCount: intake.publicSources?.length ?? 0,
    discussionSourceCount:
      intake.publicSources?.filter((source) => source.kind === "discussion_forum").length ?? 0,
    candidateCount: candidates.length,
    readyCandidateCount: readyCount,
    blockedCandidateCount: candidates.length - readyCount,
    localEvidence: {
      quoteSymbol: intake.localEvidence?.quoteSymbol ?? "",
      activeIntentCount: intake.localEvidence?.activeIntentCount ?? 0,
      signalFamilies: intake.localEvidence?.signalFamilies ?? {},
      strategyFillGate,
      monteCarloP05Pts: p05,
      tradeAutoCycleStatus: intake.localEvidence?.tradeAutoCycleStatus ?? "unknown",
      tradeAutoCycleDecision: intake.localEvidence?.tradeAutoCycleDecision ?? "unknown",
    },
    loopSteps,
    learningPacket: buildLearningPacket(intake),
    tailRiskBlocker: buildTailRiskBlockerSummary(tailRiskRepair),
    nextCommand,
    safetyLock: {
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      noOrderWrite: true,
    },
    sourceReports: {
      publicIntake: intake.paths?.reportPath,
      publicIntakeMarkdown: intake.paths?.markdownPath,
      tailRiskRepair: tailRiskRepairPath,
    },
    paths: {
      reportPath,
      markdownPath,
    },
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
    await writeText(markdownPath, buildMarkdown(report));
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalPublicStrategyResearchLoop(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `CAPITAL_PUBLIC_STRATEGY_RESEARCH_LOOP=${report.status} candidates=${report.candidateCount} ready=${report.readyCandidateCount} next=${report.nextCommand} noOrderWrite=${report.safetyLock.noOrderWrite}\n`,
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
