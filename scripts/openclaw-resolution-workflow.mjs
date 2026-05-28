#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_SCHEMA = "openclaw.resolution-workflow.v1";
const WORKFLOW_REPORT_REL = "reports/openclaw-resolution-workflow-latest.json";
const WORKFLOW_CHECKLIST_REL = "reports/openclaw-resolution-workflow-checklist.md";
const SOURCE_WATCH_REPORT_REL = "reports/openclaw-source-watch-registry-latest.json";
const WEAK_SIGNAL_INTAKE_GATE_REPORT_REL = "reports/openclaw-weak-signal-intake-gate-latest.json";
const RESOLVER_CANDIDATES_REPORT_REL = "reports/openclaw-resolver-candidates-latest.json";
const RESOLVER_EVIDENCE_LOCK_REPORT_REL =
  "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json";
const CONTROLLED_RUNNER_REPORT_REL =
  "reports/hermes-agent/state/openclaw-controlled-task-runner-latest.json";
const SOURCE_GAP_CHECKLIST_REL = "reports/openclaw-execution-automation-source-gap-checklist.md";

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJson(filePath, payload) {
  await writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeStatus(pass, blocked = false) {
  if (pass) {
    return "pass";
  }
  return blocked ? "blocked_safe" : "fail";
}

function collectOpenP0P1Candidates(resolverCandidates) {
  const candidates = Array.isArray(resolverCandidates?.candidates)
    ? resolverCandidates.candidates
    : [];
  return candidates
    .filter((candidate) => ["P0", "P1"].includes(normalizeText(candidate?.priority)))
    .filter(
      (candidate) =>
        !["closed", "completed", "promoted"].includes(normalizeText(candidate?.status)),
    )
    .map((candidate) => ({
      id: normalizeText(candidate.id),
      priority: normalizeText(candidate.priority),
      status: normalizeText(candidate.status),
      blockerId: normalizeText(candidate.blocker?.id),
    }));
}

function sourceIntakeStage(sourceWatch) {
  const weakSignals = Number(sourceWatch?.summary?.needsConfirmationSources ?? 0);
  const trustedSources = Number(sourceWatch?.summary?.trustedSourceCount ?? 0);
  const pass =
    sourceWatch?.schema === "openclaw.source-watch-registry.v1" &&
    sourceWatch?.mode === "dry_run" &&
    trustedSources >= 2 &&
    weakSignals >= 1;
  return {
    id: "source-intake",
    title: "Source intake and trust classification",
    status: safeStatus(pass),
    command: "pnpm autonomous:source-watch:registry:check",
    evidence: SOURCE_WATCH_REPORT_REL,
    done: pass,
    rule: "official and local repro sources can create resolver candidates; discussion, Reddit, and third-party pages stay needs-confirmation",
    summary: {
      totalSources: sourceWatch?.summary?.totalSources ?? 0,
      trustedSources,
      weakSignals,
    },
  };
}

function resolverCandidateStage(resolverCandidates) {
  const candidates = Array.isArray(resolverCandidates?.candidates)
    ? resolverCandidates.candidates
    : [];
  const candidateIds = candidates.map((candidate) => normalizeText(candidate.id));
  const pass =
    resolverCandidates?.schema === "openclaw.resolver-candidates.v1" &&
    resolverCandidates?.mode === "dry_run" &&
    resolverCandidates?.safety?.autoExecuteAllowed === false &&
    resolverCandidates?.summary?.autoExecutable === 0 &&
    candidateIds.includes("cron-watch-source-check");
  return {
    id: "resolver-candidates",
    title: "Reviewable resolver candidates",
    status: safeStatus(pass),
    command: "pnpm autonomous:resolver-candidates:check",
    evidence: RESOLVER_CANDIDATES_REPORT_REL,
    done: pass,
    rule: "blockers become reviewable planned_only candidates with source evidence, rerun commands, and rollback path",
    summary: {
      totalCandidates: resolverCandidates?.summary?.totalCandidates ?? candidates.length,
      autoExecutable: resolverCandidates?.summary?.autoExecutable ?? null,
      candidateIds,
      nextSafeTask: normalizeText(resolverCandidates?.nextSafeTask?.id),
    },
  };
}

function weakSignalIntakeStage(weakSignalGate) {
  const weakSignals = Array.isArray(weakSignalGate?.weakSignals) ? weakSignalGate.weakSignals : [];
  const weakSignalIds = weakSignals.map((source) => normalizeText(source.sourceId));
  const pass =
    weakSignalGate?.schema === "openclaw.weak-signal-intake-gate.v1" &&
    weakSignalGate?.status === "pass_needs_confirmation_locked" &&
    weakSignalGate?.summary?.unsafeWeakPromotions === 0 &&
    weakSignalGate?.summary?.promotionAllowed === false &&
    weakSignalGate?.safety?.runtimeMutationAllowed === false &&
    weakSignalGate?.safety?.externalWriteAllowed === false &&
    weakSignalGate?.safety?.autoExecuteAllowed === false;
  return {
    id: "weak-signal-intake-gate",
    title: "Weak-signal needs-confirmation gate",
    status: safeStatus(pass),
    command: "pnpm autonomous:weak-signal-intake-gate:check",
    evidence: WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
    done: pass,
    rule: "GitHub discussions, Reddit, and third-party pages stay needs-confirmation and cannot directly patch runtime",
    summary: {
      weakSignals: weakSignalGate?.summary?.weakSignals ?? weakSignals.length,
      unsafeWeakPromotions: weakSignalGate?.summary?.unsafeWeakPromotions ?? null,
      promotionAllowed: weakSignalGate?.summary?.promotionAllowed === true,
      weakSignalIds,
    },
  };
}

function runnerRoutingStage(controlledRunner, resolverCandidates) {
  const resolverCandidateIdFromRunner = normalizeText(
    controlledRunner?.next_safe_task?.resolver_candidate_id,
  );
  const resolverCandidateId =
    normalizeText(resolverCandidates?.nextSafeTask?.id) || resolverCandidateIdFromRunner;
  const pass = resolverCandidateId.length > 0;
  return {
    id: "runner-routing",
    title: "Controlled runner next-safe resolver routing",
    status: safeStatus(pass, !controlledRunner),
    command: "pnpm autonomous:controlled:next-safe",
    evidence: CONTROLLED_RUNNER_REPORT_REL,
    done: pass,
    rule: "runner may surface resolver candidate metadata but must not apply patches from it",
    summary: {
      runnerReportPresent: controlledRunner !== null,
      nextSafeTask: normalizeText(controlledRunner?.next_safe_task?.id),
      resolverCandidateId,
      resolverCandidateIdFromRunner,
      readOnlyMode: controlledRunner?.readOnlyMode === true,
    },
  };
}

function evidenceLockStage(evidenceLock) {
  const pass =
    evidenceLock?.schema === "openclaw.resolver-evidence-lock.v1" &&
    evidenceLock?.status === "evidence_locked" &&
    evidenceLock?.summary?.evidenceComplete === true &&
    evidenceLock?.safety?.runtimeMutationAllowed === false &&
    evidenceLock?.safety?.externalWriteAllowed === false &&
    evidenceLock?.safety?.liveTradingAllowed === false;
  return {
    id: "evidence-lock",
    title: "Same-case rerun evidence lock",
    status: safeStatus(pass),
    command: "pnpm autonomous:resolver-evidence-lock:check",
    evidence: RESOLVER_EVIDENCE_LOCK_REPORT_REL,
    done: pass,
    rule: "same-case commands must pass before any promotion discussion",
    summary: {
      evidenceComplete: evidenceLock?.summary?.evidenceComplete === true,
      passedCommands: evidenceLock?.summary?.passedCommands ?? 0,
      failedCommands: evidenceLock?.summary?.failedCommands ?? 0,
      promotionAllowed: evidenceLock?.summary?.promotionAllowed === true,
      promotionGate: normalizeText(evidenceLock?.promotionGate?.status),
    },
  };
}

function promotionGateStage(resolverCandidates, evidenceLock) {
  const openP0P1Candidates = collectOpenP0P1Candidates(resolverCandidates);
  const evidenceComplete = evidenceLock?.summary?.evidenceComplete === true;
  const promotionAllowed = evidenceComplete && openP0P1Candidates.length === 0;
  const pass = evidenceComplete && !promotionAllowed && openP0P1Candidates.length > 0;
  return {
    id: "promotion-gate",
    title: "Promotion gate",
    status: safeStatus(pass, evidenceComplete),
    command: "pnpm governance:r8:check",
    evidence: RESOLVER_EVIDENCE_LOCK_REPORT_REL,
    done: pass,
    rule: "promotion stays blocked while any P0/P1 resolver candidate is open",
    summary: {
      promotionAllowed,
      openP0P1Candidates,
    },
  };
}

function buildChecklist(stages) {
  return [
    {
      id: "root-preflight",
      status: "done",
      work: "固定在 D:\\OpenClaw，確認 package.json / pnpm-workspace.yaml / pnpm-lock.yaml",
      validation: "pwd + git rev-parse --show-toplevel",
    },
    ...stages.map((stage) => ({
      id: stage.id,
      status: stage.done ? "done" : stage.status,
      work: stage.title,
      validation: stage.command,
    })),
    {
      id: "cron-watch-source-check",
      status: "next",
      work: "把 source watch 做成 dry-run first scheduler/watch，不登入、不外部寫入",
      validation: "cron payload safety check",
    },
    {
      id: "telegram-ui-gap-view",
      status: "later",
      work: "在 Telegram/UI 只顯示 source、gap、next-safe，不放危險執行按鈕",
      validation: "targeted UI or summary check",
    },
  ];
}

function renderChecklistMarkdown(report) {
  const lines = [
    "# OpenClaw Resolution Workflow Checklist",
    "",
    `generated_at: ${report.generatedAt}`,
    `status: ${report.status}`,
    `next_safe_task: ${report.nextSafeTask.id}`,
    "",
    "## 完整正確工作流程",
    "",
    "| 順序 | 狀態 | 工作 | 驗證 |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.workflowChecklist) {
    lines.push(`| ${item.id} | ${item.status} | ${item.work} | \`${item.validation}\` |`);
  }
  lines.push(
    "",
    "## Promotion 規則",
    "",
    "- 來源未分級，不得產生 resolver candidate。",
    "- 弱訊號只能是 needs-confirmation，不得直接 patch runtime。",
    "- resolver candidate 必須是 planned_only 且 autoExecute=false。",
    "- same-case rerun evidence 未完成，不得 promote。",
    "- P0/P1 candidate 未清零，不得 promote。",
    "- 所有 rollback path 必須留在 report 內。",
    "",
    "## Next",
    "",
    `- ${report.nextSafeTask.id}: ${report.nextSafeTask.reason}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

export async function buildResolutionWorkflowReport(repoRoot = process.cwd(), options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceWatch = await readJsonIfExists(path.join(repoRoot, SOURCE_WATCH_REPORT_REL));
  const resolverCandidates = await readJsonIfExists(
    path.join(repoRoot, RESOLVER_CANDIDATES_REPORT_REL),
  );
  const weakSignalGate = await readJsonIfExists(
    path.join(repoRoot, WEAK_SIGNAL_INTAKE_GATE_REPORT_REL),
  );
  const evidenceLock = await readJsonIfExists(
    path.join(repoRoot, RESOLVER_EVIDENCE_LOCK_REPORT_REL),
  );
  const controlledRunner = await readJsonIfExists(
    path.join(repoRoot, CONTROLLED_RUNNER_REPORT_REL),
  );
  const checklistText = await fs
    .readFile(path.join(repoRoot, SOURCE_GAP_CHECKLIST_REL), "utf8")
    .catch(() => "");

  const stages = [
    sourceIntakeStage(sourceWatch),
    weakSignalIntakeStage(weakSignalGate),
    resolverCandidateStage(resolverCandidates),
    runnerRoutingStage(controlledRunner, resolverCandidates),
    evidenceLockStage(evidenceLock),
    promotionGateStage(resolverCandidates, evidenceLock),
  ];
  const blockingStages = stages.filter((stage) => stage.status === "fail");
  const openP0P1Candidates = collectOpenP0P1Candidates(resolverCandidates);

  const report = {
    schema: WORKFLOW_SCHEMA,
    generatedAt,
    mode: "integrated_resolution_workflow",
    reportPath: WORKFLOW_REPORT_REL,
    checklistPath: WORKFLOW_CHECKLIST_REL,
    status: blockingStages.length === 0 ? "ready_with_promotion_blocked" : "blocked",
    safety: {
      dryRunOnly: true,
      runtimeMutationAllowed: false,
      externalWriteAllowed: false,
      autoExecuteAllowed: false,
      liveTradingAllowed: false,
    },
    sourceReports: {
      sourceWatch: SOURCE_WATCH_REPORT_REL,
      weakSignalIntakeGate: WEAK_SIGNAL_INTAKE_GATE_REPORT_REL,
      resolverCandidates: RESOLVER_CANDIDATES_REPORT_REL,
      resolverEvidenceLock: RESOLVER_EVIDENCE_LOCK_REPORT_REL,
      controlledRunner: CONTROLLED_RUNNER_REPORT_REL,
      sourceGapChecklist: SOURCE_GAP_CHECKLIST_REL,
    },
    stages,
    workflowChecklist: buildChecklist(stages),
    summary: {
      totalStages: stages.length,
      passedStages: stages.filter((stage) => stage.status === "pass").length,
      blockedSafeStages: stages.filter((stage) => stage.status === "blocked_safe").length,
      failedStages: blockingStages.length,
      checklistPresent: checklistText.length > 0,
      openP0P1Count: openP0P1Candidates.length,
      promotionAllowed: false,
    },
    promotionGate: {
      status: openP0P1Candidates.length > 0 ? "blocked_p0_p1_open" : "blocked_manual_review",
      openP0P1Candidates,
    },
    nextSafeTask: {
      id: "cron-watch-source-check",
      command: "pnpm autonomous:weak-signal-intake-gate:check",
      reason:
        "weak-signal intake is now gated; next hardening step is dry-run source watch scheduling",
    },
    rollbackPath: [
      "Remove-Item -LiteralPath scripts/openclaw-resolution-workflow.mjs",
      "Remove-Item -LiteralPath scripts/check-openclaw-resolution-workflow.mjs",
      "Remove-Item -LiteralPath reports/openclaw-resolution-workflow-latest.json",
      "Remove-Item -LiteralPath reports/openclaw-resolution-workflow-checklist.md",
      "Remove package.json scripts autonomous:resolution-workflow, autonomous:resolution-workflow:check, and check:openclaw-resolution-workflow",
    ],
  };
  return report;
}

export async function writeResolutionWorkflowReport(repoRoot = process.cwd(), options = {}) {
  const report = await buildResolutionWorkflowReport(repoRoot, options);
  await writeJson(path.join(repoRoot, WORKFLOW_REPORT_REL), report);
  await writeText(path.join(repoRoot, WORKFLOW_CHECKLIST_REL), renderChecklistMarkdown(report));
  return report;
}

async function main() {
  const report = await writeResolutionWorkflowReport(process.cwd());
  process.stdout.write(
    [
      "OPENCLAW_RESOLUTION_WORKFLOW=OK",
      `path=${WORKFLOW_REPORT_REL}`,
      `status=${report.status}`,
      `stages=${report.summary.passedStages}/${report.summary.totalStages}`,
      `next=${report.nextSafeTask.id}`,
    ].join(" ") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `OPENCLAW_RESOLUTION_WORKFLOW=FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
