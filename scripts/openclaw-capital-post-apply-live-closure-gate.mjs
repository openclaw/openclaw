#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";
import { buildCapitalAdapterAckOperatorApplyPlan } from "./openclaw-capital-adapter-ack-operator-apply-plan.mjs";
import { buildCapitalAdapterAckOperatorApplyReceiptGate } from "./openclaw-capital-adapter-ack-operator-apply-receipt-gate.mjs";
import { buildCapitalAdapterAckOperatorApplyVerifier } from "./openclaw-capital-adapter-ack-operator-apply-verifier.mjs";
import { buildCapitalLiveReadinessGate } from "./openclaw-capital-live-readiness-gate.mjs";
import { buildCapitalLocalBrokerExecutorDispatchContract } from "./openclaw-capital-local-broker-executor-dispatch-contract.mjs";

const SCHEMA = "openclaw.capital.post-apply-live-closure-gate.v1";
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function passFail(ok) {
  return ok ? "pass" : "blocked";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(String(command || "").trim());
}

function sourceNoLiveOrderSent(report) {
  return (
    report?.safety?.sentOrder !== true &&
    report?.safety?.brokerWriteAttempted !== true &&
    report?.safety?.writeBrokerOrders !== true &&
    report?.safety?.noLiveOrderSent !== false &&
    report?.safety?.no_live_order_sent !== false
  );
}

function liveReadinessCheckStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isReadyLiveReadinessStatus(status) {
  return (
    status === "ready_for_operator_execution_review" ||
    status === "ready_for_operator_adapter_review"
  );
}

function buildLiveReadinessIncompleteChecklist(liveReadiness, repoRoot) {
  const explicitChecklist = safeArray(liveReadiness.incompleteChecklist);
  if (explicitChecklist.length > 0) {
    return explicitChecklist.map((item) => ({
      id: item.id || "",
      priority: item.priority || "",
      status: item.status || "",
      validationCommand:
        item.validationCommand || openclawPnpmCommand(repoRoot, "capital:live-readiness:check"),
    }));
  }

  const failedChecks = safeArray(liveReadiness.checks).filter((item) => {
    const status = liveReadinessCheckStatus(item?.status);
    return status === "fail" || status === "blocked";
  });
  if (failedChecks.length > 0) {
    return failedChecks.map((item) => ({
      id: item.id || "live-readiness:failed-check",
      priority: item.priority || "P0",
      status: item.status || "blocked",
      validationCommand: openclawPnpmCommand(repoRoot, "capital:live-readiness:check"),
    }));
  }

  return uniqueStrings(safeArray(liveReadiness.blockers)).map((blocker) => ({
    id: blocker,
    priority: "P0",
    status: "blocked",
    validationCommand: openclawPnpmCommand(repoRoot, "capital:live-readiness:check"),
  }));
}

function buildLiveReadinessNextCommands(liveReadiness, incompleteChecklist, repoRoot) {
  const explicitCommands = safeArray(liveReadiness.nextCommands);
  if (explicitCommands.length > 0) {
    return explicitCommands;
  }
  const checklistCommands = uniqueStrings(
    incompleteChecklist.map((item) => item.validationCommand).filter(Boolean),
  );
  return checklistCommands.length > 0
    ? checklistCommands
    : [openclawPnpmCommand(repoRoot, "capital:live-readiness:check")];
}

function deriveNextSafeTask({
  repoRoot,
  applyVerified,
  applyReceiptVerified,
  readinessReady,
  dispatchReady,
  report,
}) {
  if (!applyReceiptVerified) {
    return (
      report.adapterApplyReceipt.nextSafeTask ||
      `Rerun ${openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check")} before post-apply closure.`
    );
  }
  if (!applyVerified) {
    return `operator-owned adapter must apply ${report.applyPlan.sourcePath || "the staged ack"} to ${report.applyPlan.destinationPath || "the active ack"}, then rerun ${openclawPnpmCommand(repoRoot, "capital:trade:post-apply-closure:check")}.`;
  }
  if (!readinessReady) {
    const nextCommand =
      report.liveReadiness.nextCommands?.[0] ||
      report.liveReadiness.incompleteChecklist?.[0]?.validationCommand ||
      openclawPnpmCommand(repoRoot, "capital:live-readiness:check");
    return `Fix the first live-readiness blocker, then rerun ${nextCommand}.`;
  }
  if (!dispatchReady) {
    return `Refresh the local executor dispatch contract with ${openclawPnpmCommand(repoRoot, "capital:trade:local-executor-dispatch:check")} after executor re-arm.`;
  }
  return "Operator final review can consume the ready dispatch contract; this closure gate remains report-only and sends no broker order.";
}

function renderMarkdown(report) {
  return [
    "# Capital Post-Apply Live Closure Gate",
    "",
    `- status: ${report.status}`,
    `- sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `- adapterApplyVerified: ${report.adapterApply.verified}`,
    `- adapterApplyReceiptVerified: ${report.adapterApplyReceipt.verified}`,
    `- liveReadinessReady: ${report.liveReadiness.ready}`,
    `- localExecutorDispatchReady: ${report.localExecutorDispatch.ready}`,
    `- operatorCanExecute: ${report.operatorCanExecute}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- machineLine: ${report.machineLine}`,
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

export async function buildCapitalPostApplyLiveClosureGate(options = {}) {
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
  const applyReceipt =
    options.applyReceipt ??
    (await buildCapitalAdapterAckOperatorApplyReceiptGate({
      repoRoot,
      generatedAt,
      applyVerifier,
      applyPlan,
    }));
  const liveReadiness =
    options.liveReadiness ?? (await buildCapitalLiveReadinessGate({ repoRoot, generatedAt }));
  const dispatch =
    options.dispatch ?? (await buildCapitalLocalBrokerExecutorDispatchContract({ repoRoot }));
  const validationCommands = {
    closure: openclawPnpmCommand(repoRoot, "capital:trade:post-apply-closure:check"),
    applyVerifier: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-verifier:check"),
    applyPlan: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-plan:check"),
    applyReceipt: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check"),
    adapterAck: openclawPnpmCommand(repoRoot, "capital:trade:adapter-ack:check"),
    liveReadiness: openclawPnpmCommand(repoRoot, "capital:live-readiness:check"),
    localExecutorDispatch: openclawPnpmCommand(
      repoRoot,
      "capital:trade:local-executor-dispatch:check",
    ),
    direct: openclawPnpmCommand(repoRoot, "capital:trade:direct:check"),
  };
  const commandsQualified = Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const applyVerdict = applyVerifier.applyVerdict ?? {};
  const operatorApplyPlan = applyPlan.operatorApplyPlan ?? {};
  const operatorReceipt = applyReceipt.operatorReceipt ?? {};
  const applyReceiptAppliedVerified =
    applyReceipt.status === "applied_receipt_verified" &&
    operatorReceipt.operatorApplyVerified === true &&
    operatorReceipt.alreadyAppliedVerified === true &&
    operatorReceipt.activeState === "applied_candidate_matches";
  const applyReceiptNoApplyRequiredVerified =
    applyReceipt.status === "no_apply_required" &&
    operatorReceipt.noApplyRequired === true &&
    operatorReceipt.operatorMayApply !== true &&
    operatorReceipt.operatorApplyVerified !== true &&
    operatorReceipt.alreadyAppliedVerified !== true &&
    operatorReceipt.activeState === "pre_apply_current_matches";
  const applyReceiptVerified = applyReceiptAppliedVerified || applyReceiptNoApplyRequiredVerified;
  const applyAppliedVerified =
    applyReceiptAppliedVerified &&
    applyVerifier.status === "applied_verified" &&
    applyVerdict.operatorApplyVerified === true &&
    applyVerdict.activeState === "applied_candidate_matches" &&
    operatorApplyPlan.alreadyAppliedVerified === true;
  const applyNoApplyRequiredVerified =
    applyReceiptNoApplyRequiredVerified &&
    applyVerifier.status === "no_apply_required" &&
    applyVerdict.operatorMayApply !== true &&
    applyVerdict.operatorApplyVerified !== true &&
    applyVerdict.activeState === "pre_apply_current_matches" &&
    applyPlan.status === "no_apply_required" &&
    operatorApplyPlan.noApplyRequired === true;
  const applyVerified = applyAppliedVerified || applyNoApplyRequiredVerified;
  const liveReadinessIncompleteChecklist = buildLiveReadinessIncompleteChecklist(
    liveReadiness,
    repoRoot,
  );
  const liveReadinessIncompleteCount = Number(
    liveReadiness.incompleteCount ?? liveReadinessIncompleteChecklist.length,
  );
  const liveReadinessNextCommands = buildLiveReadinessNextCommands(
    liveReadiness,
    liveReadinessIncompleteChecklist,
    repoRoot,
  );
  const liveReadinessOperatorCanExecute =
    liveReadiness.operatorCanExecute === true || isReadyLiveReadinessStatus(liveReadiness.status);
  const readinessReady =
    isReadyLiveReadinessStatus(liveReadiness.status) &&
    liveReadinessIncompleteCount === 0 &&
    safeArray(liveReadiness.blockers).length === 0;
  const dispatchReady =
    dispatch.status === "ready_for_local_executor_final_confirmation" &&
    dispatch.dispatchPolicy ===
      "local_executor_may_dispatch_after_executor_owned_final_confirmation" &&
    dispatch.safety?.localBrokerExecutorWriteAllowedAfterGates === true;
  const noLiveOrderSent =
    sourceNoLiveOrderSent(applyVerifier) &&
    sourceNoLiveOrderSent(applyPlan) &&
    sourceNoLiveOrderSent(applyReceipt) &&
    sourceNoLiveOrderSent(liveReadiness) &&
    sourceNoLiveOrderSent(dispatch);
  const checks = [
    check("adapter-apply:receipt-verified", applyReceiptVerified, {
      status: applyReceipt.status || "",
      operatorApplyVerified: operatorReceipt.operatorApplyVerified === true,
      alreadyAppliedVerified: operatorReceipt.alreadyAppliedVerified === true,
      noApplyRequired: operatorReceipt.noApplyRequired === true,
      activeState: operatorReceipt.activeState || "",
    }),
    check("adapter-apply:verified-active-candidate", applyVerified, {
      verifierStatus: applyVerifier.status,
      activeState: applyVerdict.activeState || "",
      operatorApplyVerified: applyVerdict.operatorApplyVerified === true,
      applyPlanStatus: applyPlan.status || "",
      alreadyAppliedVerified: operatorApplyPlan.alreadyAppliedVerified === true,
      noApplyRequired: operatorApplyPlan.noApplyRequired === true,
    }),
    check("live-readiness:operator-execution-review-ready", readinessReady, {
      status: liveReadiness.status || "",
      operatorCanExecute: liveReadinessOperatorCanExecute,
      incompleteCount: liveReadinessIncompleteCount,
    }),
    check("local-executor:dispatch-final-confirmation-ready", dispatchReady, {
      status: dispatch.status || "",
      dispatchPolicy: dispatch.dispatchPolicy || "",
      localBrokerExecutorWriteAllowedAfterGates:
        dispatch.safety?.localBrokerExecutorWriteAllowedAfterGates === true,
    }),
    check("commands:repo-root-qualified", commandsQualified, validationCommands),
    check("safety:no-live-order-sent", noLiveOrderSent, {
      applyVerifier: sourceNoLiveOrderSent(applyVerifier),
      applyPlan: sourceNoLiveOrderSent(applyPlan),
      applyReceipt: sourceNoLiveOrderSent(applyReceipt),
      liveReadiness: sourceNoLiveOrderSent(liveReadiness),
      localExecutorDispatch: sourceNoLiveOrderSent(dispatch),
    }),
  ];
  const blockers = uniqueStrings([
    ...(applyReceiptVerified ? [] : ["adapterAck:operator-apply-receipt-not-verified"]),
    ...(applyVerified ? [] : ["adapterAck:operator-apply-not-verified"]),
    ...(readinessReady
      ? []
      : liveReadinessIncompleteChecklist.length > 0
        ? liveReadinessIncompleteChecklist.map((item) => `liveReadiness:${item.id}`)
        : ["liveReadiness:not-ready"]),
    ...(dispatchReady
      ? []
      : safeArray(dispatch.blockers).length > 0
        ? safeArray(dispatch.blockers).map((item) => `localExecutor:${item}`)
        : ["localExecutor:dispatch-not-ready"]),
    ...(commandsQualified ? [] : ["commands:not-repo-root-qualified"]),
    ...(noLiveOrderSent ? [] : ["safety:live-order-state-not-clean"]),
  ]);
  const status = !noLiveOrderSent
    ? "blocked_safety_reconcile_required"
    : blockers.length === 0
      ? "closed_ready_for_operator_final_review"
      : "blocked_post_apply_closure_incomplete";
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-post-apply-live-closure-gate-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-post-apply-live-closure-gate-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-post-apply-live-closure-gate.json");
  const sealedIntentSha256 =
    applyVerifier.sealedIntentSha256 ||
    applyPlan.sealedIntentSha256 ||
    liveReadiness.sealedOrderIntent?.sha256 ||
    dispatch.sealedIntentSha256 ||
    "";
  const report = {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status,
    mode: "post_apply_live_closure_report_only",
    sealedIntentSha256,
    operatorCanExecute: status === "closed_ready_for_operator_final_review",
    adapterApply: {
      verified: applyVerified,
      verifierStatus: applyVerifier.status || "",
      activeState: applyVerdict.activeState || "",
      operatorMayApply: applyVerdict.operatorMayApply === true,
      operatorApplyVerified: applyVerdict.operatorApplyVerified === true,
      noApplyRequired: operatorApplyPlan.noApplyRequired === true,
      expectedSealedIntentSha256: applyVerdict.sealedIntentSha256 || "",
      activeSealedIntentSha256: applyVerdict.destinationSealedIntentSha256 || "",
      candidateContentSha256: applyVerdict.candidateContentSha256 || "",
      activeContentSha256: applyVerdict.destinationContentSha256 || "",
      candidateRollbackVerifiedAt: applyVerdict.candidateRollbackVerifiedAt || "",
      reportPath: applyVerifier.paths?.reportPath || "",
    },
    applyPlan: {
      status: applyPlan.status || "",
      applyAllowedByPlan: operatorApplyPlan.applyAllowedByPlan === true,
      alreadyAppliedVerified: operatorApplyPlan.alreadyAppliedVerified === true,
      noApplyRequired: operatorApplyPlan.noApplyRequired === true,
      sourcePath: operatorApplyPlan.sourcePath || "",
      destinationPath: operatorApplyPlan.destinationPath || "",
      backupPath: operatorApplyPlan.backupPath || "",
      tempPath: operatorApplyPlan.tempPath || "",
      reportPath: applyPlan.paths?.reportPath || "",
    },
    adapterApplyReceipt: {
      verified: applyReceiptVerified,
      status: applyReceipt.status || "",
      action: operatorReceipt.action || "",
      operatorMayApply: operatorReceipt.operatorMayApply === true,
      operatorApplyVerified: operatorReceipt.operatorApplyVerified === true,
      applyAllowedByPlan: operatorReceipt.applyAllowedByPlan === true,
      alreadyAppliedVerified: operatorReceipt.alreadyAppliedVerified === true,
      noApplyRequired: operatorReceipt.noApplyRequired === true,
      activeState: operatorReceipt.activeState || "",
      expectedSealedIntentSha256: operatorReceipt.expectedSealedIntentSha256 || "",
      activeSealedIntentSha256: operatorReceipt.activeSealedIntentSha256 || "",
      currentContentSha256: operatorReceipt.currentContentSha256 || "",
      candidateContentSha256: operatorReceipt.candidateContentSha256 || "",
      activeContentSha256: operatorReceipt.activeContentSha256 || "",
      sourcePath: operatorReceipt.sourcePath || "",
      destinationPath: operatorReceipt.destinationPath || "",
      backupPath: operatorReceipt.backupPath || "",
      tempPath: operatorReceipt.tempPath || "",
      candidateRollbackVerifiedAt: operatorReceipt.candidateRollbackVerifiedAt || "",
      nextSafeTask: applyReceipt.nextSafeTask || "",
      reportPath: applyReceipt.paths?.reportPath || "",
    },
    liveReadiness: {
      ready: readinessReady,
      status: liveReadiness.status || "",
      operatorCanExecute: liveReadinessOperatorCanExecute,
      incompleteCount: liveReadinessIncompleteCount,
      incompleteChecklist: liveReadinessIncompleteChecklist.map((item) => ({
        id: item.id || "",
        priority: item.priority || "",
        status: item.status || "",
        validationCommand: item.validationCommand || "",
      })),
      nextCommands: readinessReady
        ? safeArray(liveReadiness.nextCommands)
        : liveReadinessNextCommands,
      reportPath: liveReadiness.paths?.reportPath || "",
    },
    localExecutorDispatch: {
      ready: dispatchReady,
      status: dispatch.status || "",
      dispatchPolicy: dispatch.dispatchPolicy || "",
      operatorCanExecute: dispatch.operatorPacket?.operatorCanExecute === true,
      executorArmed: dispatch.executor?.armed === true,
      blockers: safeArray(dispatch.blockers),
      reportPath: dispatch.paths?.reportPath || "",
    },
    checks,
    blockers,
    validationCommands,
    safety: {
      reportOnly: true,
      generatedClosureOnly: true,
      wroteActiveAdapterAck: false,
      wroteBrokerCommand: false,
      brokerApiCalled: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      localBrokerExecutorWriteAllowedAfterGates:
        status === "closed_ready_for_operator_final_review",
      conversationAgentDirectBrokerWrite: false,
      containsCredentials: false,
      sentOrder: false,
      noLiveOrderSent,
      no_live_order_sent: noLiveOrderSent,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
    },
    commandSurface: {
      schema: "openclaw.command-surface.repo-root-pnpm.v1",
      repoRoot,
      noPkgManifestAvoided: true,
    },
  };
  report.nextSafeTask = deriveNextSafeTask({
    repoRoot,
    applyVerified,
    applyReceiptVerified,
    readinessReady,
    dispatchReady,
    report,
  });
  report.machineLine = [
    `capitalPostApplyClosure=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `adapterApplyVerified=${applyVerified}`,
    `adapterApplyReceiptVerified=${applyReceiptVerified}`,
    `liveReadinessReady=${readinessReady}`,
    `localDispatchReady=${dispatchReady}`,
    `operatorCanExecute=${report.operatorCanExecute}`,
    `noLiveOrderSent=${noLiveOrderSent}`,
    "sentOrder=false",
    "noOrderWrite=true",
    `blockers=${blockers.length}`,
  ].join(" ");

  return report;
}

async function main() {
  const report = await buildCapitalPostApplyLiveClosureGate({ repoRoot: process.cwd() });

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
      report.safety.noLiveOrderSent !== true)
  ) {
    throw new Error("CAPITAL_POST_APPLY_LIVE_CLOSURE_UNSAFE_STATE");
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
      `capital post-apply live closure gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
