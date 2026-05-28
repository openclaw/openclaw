#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";
import { buildCapitalAdapterAckOperatorApplyPlan } from "./openclaw-capital-adapter-ack-operator-apply-plan.mjs";
import { buildCapitalAdapterAckOperatorApplyVerifier } from "./openclaw-capital-adapter-ack-operator-apply-verifier.mjs";

const SCHEMA = "openclaw.capital.adapter-ack-operator-apply-receipt-gate.v1";
const RECEIPT_SCHEMA = "openclaw.capital.external-broker-adapter-ack-operator-apply-receipt.v1";
const currentFile = fileURLToPath(import.meta.url);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function sourceNoLiveOrderSent(report) {
  return (
    report?.safety?.sentOrder !== true &&
    report?.safety?.brokerWriteAttempted !== true &&
    report?.safety?.writeBrokerOrders !== true &&
    report?.safety?.wroteActiveAdapterAck !== true &&
    report?.safety?.wroteBackup !== true &&
    report?.safety?.wroteTemp !== true &&
    report?.safety?.noLiveOrderSent !== false &&
    report?.safety?.no_live_order_sent !== false
  );
}

function renderMarkdown(report) {
  return [
    "# Capital Adapter Ack Operator Apply Receipt Gate",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `operatorMayApply: ${report.operatorReceipt.operatorMayApply}`,
    `operatorApplyVerified: ${report.operatorReceipt.operatorApplyVerified}`,
    `activeState: ${report.operatorReceipt.activeState || "missing"}`,
    `handoffNextAction: ${report.operatorHandoff?.nextAction || "missing"}`,
    `handoffAllowedActor: ${report.operatorHandoff?.allowedActor || "missing"}`,
    `sourcePath: ${report.operatorReceipt.sourcePath || "missing"}`,
    `destinationPath: ${report.operatorReceipt.destinationPath || "missing"}`,
    `noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `machineLine: ${report.machineLine}`,
    "",
    "## Checks",
    ...report.checks.map((item) => `- ${item.id}: ${item.status}`),
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

function deriveNextSafeTask({ repoRoot, status, receipt }) {
  if (status === "applied_receipt_verified" || status === "no_apply_required") {
    return `Adapter ack apply receipt is verified; rerun ${openclawPnpmCommand(repoRoot, "capital:trade:post-apply-closure:check")}.`;
  }
  if (status === "pending_operator_apply") {
    return `operator-owned adapter must apply ${receipt.sourcePath || "the staged ack"} to ${receipt.destinationPath || "the active ack"}, then rerun ${openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check")}.`;
  }
  return "Fix adapter ack operator apply receipt blockers before post-apply closure.";
}

function buildOperatorHandoff({ status, receipt, plan, validationCommands }) {
  const nextAction =
    status === "applied_receipt_verified" || status === "no_apply_required"
      ? "rerun_post_apply_closure"
      : status === "pending_operator_apply"
        ? "operator_adapter_atomic_apply"
        : "fix_receipt_blockers";
  const requiredValidation =
    status === "applied_receipt_verified" || status === "no_apply_required"
      ? [validationCommands.postApplyClosure, validationCommands.direct]
      : status === "pending_operator_apply"
        ? [
            validationCommands.receipt,
            validationCommands.adapterAck,
            validationCommands.postApplyClosure,
          ]
        : [
            validationCommands.applyVerifier,
            validationCommands.applyPlan,
            validationCommands.receipt,
          ];

  return {
    schema: "openclaw.capital.adapter-ack-operator-handoff.v1",
    status,
    owner: "operator-owned-broker-adapter-only",
    reportOnly: true,
    nextAction,
    allowedActor: "operator-controlled-broker-adapter",
    disallowedActors: ["codex", "claude", "openclaw-telegram", "openclaw-automation"],
    sourcePath: receipt.sourcePath,
    destinationPath: receipt.destinationPath,
    backupPath: receipt.backupPath,
    tempPath: receipt.tempPath,
    sealedIntentSha256: receipt.sealedIntentSha256,
    currentContentSha256: receipt.currentContentSha256,
    candidateContentSha256: receipt.candidateContentSha256,
    preconditions: Array.isArray(plan.preconditions) ? plan.preconditions : [],
    requiredValidation,
    safety: {
      brokerOrderWriteAllowed: false,
      automationMayWriteActiveAck: false,
      telegramMayWriteActiveAck: false,
      reportOnly: true,
      noLiveOrderSent: true,
    },
  };
}

export async function buildCapitalAdapterAckOperatorApplyReceiptGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const applyVerifier =
    options.applyVerifier ??
    (await buildCapitalAdapterAckOperatorApplyVerifier({ repoRoot, generatedAt }));
  const applyPlan =
    options.applyPlan ??
    (await buildCapitalAdapterAckOperatorApplyPlan({
      repoRoot,
      generatedAt,
      verifier: applyVerifier,
    }));
  const verdict = applyVerifier.applyVerdict ?? {};
  const plan = applyPlan.operatorApplyPlan ?? {};
  const validationCommands = {
    receipt: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check"),
    applyVerifier: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-verifier:check"),
    applyPlan: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-plan:check"),
    adapterAck: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    postApplyClosure: openclawPnpmCommand(repoRoot, "capital:trade:post-apply-closure:check"),
    direct: openclawPnpmCommand(repoRoot, "capital:trade:direct:check"),
  };
  const commandsQualified = Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const sealedIntentSha256 = safeString(
    verdict.sealedIntentSha256 || applyVerifier.sealedIntentSha256,
  );
  const receiptSealedHashConsistent =
    sealedIntentSha256.length > 0 && safeString(plan.sealedIntentSha256) === sealedIntentSha256;
  const pathsConsistent =
    safeString(verdict.sourcePath).length > 0 &&
    safeString(verdict.destinationPath).length > 0 &&
    safeString(verdict.sourcePath) === safeString(plan.sourcePath) &&
    safeString(verdict.destinationPath) === safeString(plan.destinationPath) &&
    safeString(verdict.backupPath) === safeString(plan.backupPath);
  const contentHashesConsistent =
    safeString(verdict.currentContentSha256).length > 0 &&
    safeString(verdict.candidateContentSha256).length > 0 &&
    safeString(verdict.currentContentSha256) === safeString(plan.currentContentSha256) &&
    safeString(verdict.candidateContentSha256) === safeString(plan.candidateContentSha256);
  const pendingOperatorApply =
    applyVerifier.status === "ready_for_operator_apply" &&
    verdict.operatorMayApply === true &&
    verdict.operatorApplyVerified !== true &&
    verdict.activeState === "pre_apply_current_matches" &&
    applyPlan.status === "ready_atomic_apply_plan" &&
    plan.applyAllowedByPlan === true &&
    plan.alreadyAppliedVerified !== true;
  const appliedReceiptVerified =
    applyVerifier.status === "applied_verified" &&
    verdict.operatorMayApply !== true &&
    verdict.operatorApplyVerified === true &&
    verdict.activeState === "applied_candidate_matches" &&
    applyPlan.status === "already_applied_verified" &&
    plan.applyAllowedByPlan !== true &&
    plan.alreadyAppliedVerified === true;
  const noApplyRequiredReceiptVerified =
    applyVerifier.status === "no_apply_required" &&
    verdict.operatorMayApply !== true &&
    verdict.operatorApplyVerified !== true &&
    verdict.activeState === "pre_apply_current_matches" &&
    applyPlan.status === "no_apply_required" &&
    plan.applyAllowedByPlan !== true &&
    plan.noApplyRequired === true;
  const receiptStateClassified =
    pendingOperatorApply || appliedReceiptVerified || noApplyRequiredReceiptVerified;
  const noLiveOrderSent = sourceNoLiveOrderSent(applyVerifier) && sourceNoLiveOrderSent(applyPlan);
  const checks = [
    check(
      "verifier:ready-or-applied",
      ["ready_for_operator_apply", "applied_verified", "no_apply_required"].includes(
        applyVerifier.status,
      ),
      {
        status: applyVerifier.status || "",
      },
    ),
    check(
      "plan:ready-or-already-applied",
      ["ready_atomic_apply_plan", "already_applied_verified", "no_apply_required"].includes(
        applyPlan.status,
      ),
      {
        status: applyPlan.status || "",
      },
    ),
    check("receipt:sealed-hash-consistent", receiptSealedHashConsistent, {
      verifierSealedIntentSha256: sealedIntentSha256,
      planSealedIntentSha256: safeString(plan.sealedIntentSha256),
    }),
    check("receipt:paths-consistent", pathsConsistent, {
      verifierSourcePath: safeString(verdict.sourcePath),
      planSourcePath: safeString(plan.sourcePath),
      verifierDestinationPath: safeString(verdict.destinationPath),
      planDestinationPath: safeString(plan.destinationPath),
      verifierBackupPath: safeString(verdict.backupPath),
      planBackupPath: safeString(plan.backupPath),
    }),
    check("receipt:content-hashes-consistent", contentHashesConsistent, {
      verifierCurrentContentSha256: safeString(verdict.currentContentSha256),
      planCurrentContentSha256: safeString(plan.currentContentSha256),
      verifierCandidateContentSha256: safeString(verdict.candidateContentSha256),
      planCandidateContentSha256: safeString(plan.candidateContentSha256),
    }),
    check("receipt:state-classified", receiptStateClassified, {
      verifierStatus: applyVerifier.status || "",
      planStatus: applyPlan.status || "",
      activeState: safeString(verdict.activeState),
      operatorMayApply: verdict.operatorMayApply === true,
      operatorApplyVerified: verdict.operatorApplyVerified === true,
      applyAllowedByPlan: plan.applyAllowedByPlan === true,
      alreadyAppliedVerified: plan.alreadyAppliedVerified === true,
      noApplyRequired: plan.noApplyRequired === true,
    }),
    check("commands:repo-root-qualified", commandsQualified, validationCommands),
    check("safety:report-only", true, {
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
    }),
    check("safety:no-live-order-sent", noLiveOrderSent, {
      applyVerifier: sourceNoLiveOrderSent(applyVerifier),
      applyPlan: sourceNoLiveOrderSent(applyPlan),
    }),
  ];
  const failedCheckIds = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status = !noLiveOrderSent
    ? "blocked_safety_reconcile_required"
    : failedCheckIds.length === 0 && appliedReceiptVerified
      ? "applied_receipt_verified"
      : failedCheckIds.length === 0 && noApplyRequiredReceiptVerified
        ? "no_apply_required"
        : failedCheckIds.length === 0 && pendingOperatorApply
          ? "pending_operator_apply"
          : "blocked_apply_receipt_incomplete";
  const semanticBlockers =
    status === "pending_operator_apply"
      ? ["operator-apply:pending"]
      : status === "applied_receipt_verified" || status === "no_apply_required"
        ? []
        : ["operator-apply:receipt-incomplete"];
  const blockers = [...failedCheckIds, ...semanticBlockers];
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-adapter-ack-operator-apply-receipt-gate.json");
  const receipt = {
    schema: RECEIPT_SCHEMA,
    generatedAt,
    status,
    owner: "operator-owned-broker-adapter-only",
    reportOnly: true,
    action:
      status === "applied_receipt_verified"
        ? "post_apply_closure_required"
        : status === "no_apply_required"
          ? "no_apply_required_post_apply_closure"
          : status === "pending_operator_apply"
            ? "operator_apply_required"
            : "fix_receipt_blockers",
    operatorMayApply: status === "pending_operator_apply",
    operatorApplyVerified: status === "applied_receipt_verified",
    applyAllowedByPlan: plan.applyAllowedByPlan === true,
    alreadyAppliedVerified: plan.alreadyAppliedVerified === true,
    noApplyRequired: status === "no_apply_required",
    activeState: safeString(verdict.activeState),
    sealedIntentSha256,
    expectedSealedIntentSha256: sealedIntentSha256,
    activeSealedIntentSha256: safeString(verdict.destinationSealedIntentSha256),
    currentContentSha256: safeString(verdict.currentContentSha256),
    candidateContentSha256: safeString(verdict.candidateContentSha256),
    activeContentSha256: safeString(verdict.destinationContentSha256),
    sourcePath: safeString(verdict.sourcePath),
    destinationPath: safeString(verdict.destinationPath),
    backupPath: safeString(plan.backupPath || verdict.backupPath),
    tempPath: safeString(plan.tempPath),
    packetPath: safeString(verdict.packetPath),
    applyPlanPath: safeString(applyPlan.paths?.planPath),
    applyVerifierReportPath: safeString(applyVerifier.paths?.reportPath),
    candidateRollbackVerifiedAt: safeString(verdict.candidateRollbackVerifiedAt),
    validationCommands,
    safety: {
      reportOnly: true,
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
  };
  const operatorHandoff = buildOperatorHandoff({
    status,
    receipt,
    plan,
    validationCommands,
  });
  const nextSafeTask = deriveNextSafeTask({ repoRoot, status, receipt });
  const machineLine = [
    `capitalAdapterAckApplyReceipt=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `operatorMayApply=${receipt.operatorMayApply}`,
    `operatorApplyVerified=${receipt.operatorApplyVerified}`,
    `noApplyRequired=${receipt.noApplyRequired}`,
    `noLiveOrderSent=${noLiveOrderSent}`,
    "sentOrder=false",
    "noOrderWrite=true",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "operator_owned_adapter_apply_receipt_gate_report_only",
    sealedIntentSha256,
    machineLine,
    operatorReceipt: receipt,
    operatorHandoff,
    checks,
    blockers,
    validationCommands,
    safety: {
      reportOnly: true,
      generatedReceiptOnly: true,
      wroteActiveAdapterAck: false,
      wroteBackup: false,
      wroteTemp: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      sentOrder: false,
      noLiveOrderSent,
      no_live_order_sent: noLiveOrderSent,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      applyVerifierReportPath: safeString(applyVerifier.paths?.reportPath),
      applyPlanReportPath: safeString(applyPlan.paths?.reportPath),
      applyPlanPath: safeString(applyPlan.paths?.planPath),
    },
    nextSafeTask,
  };
}

async function main() {
  const report = await buildCapitalAdapterAckOperatorApplyReceiptGate({
    repoRoot: process.cwd(),
  });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
    await writeJsonWithSha(report.paths.panelPath, report);
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder === true ||
      report.safety.brokerWriteAttempted === true ||
      report.safety.writeBrokerOrders === true ||
      report.safety.wroteActiveAdapterAck === true ||
      report.safety.noLiveOrderSent !== true)
  ) {
    throw new Error("CAPITAL_ADAPTER_ACK_OPERATOR_APPLY_RECEIPT_UNSAFE_STATE");
  }

  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital adapter ack operator apply receipt gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
