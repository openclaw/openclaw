#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalLiveOperatorExecutionPacket } from "./openclaw-capital-live-operator-execution-packet.mjs";

const SCHEMA = "openclaw.capital.local-broker-executor-dispatch-contract.v1";
const EXECUTOR_ID = "openclaw-managed-capital-live-executor";
const EXECUTOR_TARGET = "openclaw_managed_local_broker_executor";
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
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

function renderMarkdown(report) {
  return [
    "# Capital Local Broker Executor Dispatch Contract",
    "",
    `- status: ${report.status}`,
    `- sealedIntentSha256: ${report.sealedIntentSha256 || "missing"}`,
    `- operatorCanExecute: ${report.operatorPacket.operatorCanExecute}`,
    `- adapterAck: ${report.adapterAck.status || "missing"}`,
    `- adapterAck.candidateRollbackVerifiedAt: ${
      report.adapterAck.refreshPlan?.candidateRollbackVerifiedAt || "missing"
    }`,
    `- executorArmed: ${report.executor.armed}`,
    `- dispatchPolicy: ${report.dispatchPolicy}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- machineLine: ${report.machineLine}`,
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export async function buildCapitalLocalBrokerExecutorDispatchContract(options = {}) {
  const resolvedRepoRoot = path.resolve(options.repoRoot ?? repoRoot);
  const stateRoot = path.join(resolvedRepoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(resolvedRepoRoot, ".openclaw", "trading");
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const operatorPacket =
    options.operatorPacket ??
    (await buildCapitalLiveOperatorExecutionPacket({ repoRoot: resolvedRepoRoot }));
  const executorArm = operatorPacket.liveExecutorArmProfile ?? {};
  const operatorCanExecute = operatorPacket.operatorCanExecute === true;
  const executorAllowBrokerWriteWhenAllGatesPass =
    executorArm.allowBrokerWriteWhenAllGatesPass === true ||
    executorArm.allowExecutorWrite === true;
  const executorArmed =
    executorArm.status === "armed" &&
    executorAllowBrokerWriteWhenAllGatesPass &&
    operatorPacket.executionPayload?.liveExecutorArmed === true;
  const noLiveOrderSent =
    operatorPacket.safety?.sentOrder !== true &&
    operatorPacket.safety?.noLiveOrderSent !== false &&
    operatorPacket.safety?.brokerWriteAttempted !== true;
  const adapterAck = operatorPacket.adapterAck ?? {};
  const adapterAckRefreshPlan = adapterAck.refreshPlan ?? {};
  const adapterAckRefreshPlanSummary = {
    status: adapterAckRefreshPlan.status || "",
    reason: adapterAckRefreshPlan.reason || "",
    sourcePath: adapterAckRefreshPlan.sourcePath || "",
    destinationPath: adapterAckRefreshPlan.destinationPath || "",
    expectedSealedIntentSha256: adapterAckRefreshPlan.expectedSealedIntentSha256 || "",
    actualSealedIntentSha256: adapterAckRefreshPlan.actualSealedIntentSha256 || "",
    candidateSealedIntentSha256: adapterAckRefreshPlan.candidateSealedIntentSha256 || "",
    candidateRollbackVerifiedAt:
      adapterAckRefreshPlan.candidateRollbackVerifiedAt || adapterAck.rollbackVerifiedAt || "",
    safeToPromoteCandidate: adapterAckRefreshPlan.safeToPromoteCandidate === true,
    validationCommand: adapterAckRefreshPlan.validationCommand || "",
    postRefreshValidationCommand: adapterAckRefreshPlan.postRefreshValidationCommand || "",
    allowedWriter: adapterAckRefreshPlan.allowedWriter || adapterAck.allowedWriter || "",
  };
  const dispatchReady = operatorCanExecute && executorArmed && noLiveOrderSent;
  const status = dispatchReady ? "ready_for_local_executor_final_confirmation" : "blocked";
  const dispatchPolicy = dispatchReady
    ? "local_executor_may_dispatch_after_executor_owned_final_confirmation"
    : "blocked_do_not_send";
  const sealedIntentSha256 = operatorPacket.sealedIntentSha256 || "";
  const executionPayload = operatorPacket.executionPayload ?? {};
  const payloadHash = sha256Text(JSON.stringify(executionPayload));
  const blockers = dispatchReady
    ? []
    : [
        ...(operatorCanExecute ? [] : ["operatorPacket:not-executable"]),
        ...(executorArmed ? [] : ["executor:arm-profile-not-armed"]),
        ...(noLiveOrderSent ? [] : ["safety:live-order-state-not-clean"]),
        ...safeArray(operatorPacket.blockers).map((item) => `operatorPacket:${item}`),
      ];
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-local-broker-executor-dispatch-contract-latest.md",
  );
  const panelPath = path.join(tradingRoot, "capital-local-broker-executor-dispatch-contract.json");
  const machineLine = [
    `capitalLocalExecutorDispatch=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `operatorCanExecute=${operatorCanExecute}`,
    `executorArmed=${executorArmed}`,
    `dispatchPolicy=${dispatchPolicy}`,
    `payloadHash=${payloadHash}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "local_broker_executor_dispatch_contract_report_only",
    sealedIntentSha256,
    dispatchPolicy,
    machineLine,
    operatorPacket: {
      status: operatorPacket.status || "",
      operatorCanExecute,
      readinessStatus: operatorPacket.readiness?.status || "",
      adapterAckStatus: operatorPacket.adapterAck?.status || "",
      adapterAckHashOk: adapterAck.hashOk === true,
      adapterAckRefreshPlan: adapterAckRefreshPlanSummary,
      dispatchPolicy: executionPayload.dispatchPolicy || "",
      blockers: safeArray(operatorPacket.blockers),
      reportPath: operatorPacket.paths?.reportPath || "",
    },
    adapterAck: {
      status: adapterAck.status || "",
      hashOk: adapterAck.hashOk === true,
      canarySentOrder: adapterAck.canarySentOrder === true,
      rollbackVerifiedAt: adapterAck.rollbackVerifiedAt || "",
      rollbackFresh: adapterAck.rollbackFresh === true,
      expectedSealedIntentSha256: adapterAck.expectedSealedIntentSha256 || "",
      actualSealedIntentSha256: adapterAck.actualSealedIntentSha256 || "",
      activeAckPath: adapterAck.activeAckPath || "",
      stagedCandidateAckPath: adapterAck.stagedCandidateAckPath || "",
      refreshPlan: adapterAckRefreshPlanSummary,
    },
    executor: {
      id: EXECUTOR_ID,
      target: EXECUTOR_TARGET,
      armed: executorArmed,
      armStatus: executorArm.status || "",
      allowBrokerWriteWhenAllGatesPass: executorAllowBrokerWriteWhenAllGatesPass,
      armProfilePath: executorArm.profilePath || "",
      armExpiresAt: executorArm.expiresAt || "",
      finalConfirmationRequired: true,
      credentialOwner: "local_broker_executor",
    },
    dispatchContract: {
      destination: EXECUTOR_TARGET,
      payloadHash,
      brokerApi: executionPayload.brokerApi || "",
      brokerStruct: executionPayload.brokerStruct || "",
      commandPayload: executionPayload.commandPayload ?? {},
      brokerFields: executionPayload.brokerFields ?? {},
      sealedOrderIntent: executionPayload.sealedOrderIntent ?? {},
      writesBrokerCommandFile: false,
      brokerApiCalled: false,
    },
    blockers: [...new Set(blockers)],
    safety: {
      generatedContractOnly: true,
      reportOnly: true,
      wroteBrokerCommand: false,
      brokerApiCalled: false,
      brokerWriteAttempted: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      localBrokerExecutorWriteAllowedAfterGates: dispatchReady,
      conversationAgentDirectBrokerWrite: false,
      containsCredentials: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
      operatorPacketReportPath: operatorPacket.paths?.reportPath || "",
    },
    nextSafeTask: dispatchReady
      ? "Executor-owned final confirmation can consume this contract; this script still never calls broker APIs."
      : "Keep local executor dispatch blocked until operator packet is executable and arm profile is armed.",
  };
}

async function main() {
  const report = await buildCapitalLocalBrokerExecutorDispatchContract({
    repoRoot: path.resolve(argValue("--repo-root", process.cwd())),
  });

  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }

  if (
    hasFlag("--check") &&
    (report.safety.sentOrder || report.safety.brokerWriteAttempted || report.safety.brokerApiCalled)
  ) {
    throw new Error("CAPITAL_LOCAL_EXECUTOR_DISPATCH_CONTRACT_UNSAFE_ORDER_WRITE");
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
      `capital local broker executor dispatch contract failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
