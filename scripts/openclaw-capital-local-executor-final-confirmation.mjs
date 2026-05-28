#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { buildCapitalLiveExecutorProfileRearm } from "./openclaw-capital-live-executor-profile-rearm.mjs";
import { buildCapitalLocalBrokerExecutorDispatchContract } from "./openclaw-capital-local-broker-executor-dispatch-contract.mjs";

const SCHEMA = "openclaw.capital.local-executor-final-confirmation.v1";
const READY_STATUS = "ready_for_local_executor_final_confirmation";
const READY_DISPATCH_POLICY = "local_executor_may_dispatch_after_executor_owned_final_confirmation";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text.length > 0 ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
    execute: false,
    confirmSha256: "",
    autoRearm: false,
    autoConfirmSha256: false,
    rearmTtlSeconds: "",
    rearmOperator: "",
    rearmOperatorSignature: "",
    rearmReason: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--confirm-sha256") {
      options.confirmSha256 = String(argv[index + 1] || "")
        .trim()
        .toUpperCase();
      index += 1;
    } else if (arg === "--auto-rearm") {
      options.autoRearm = true;
    } else if (arg === "--auto-confirm-sha256") {
      options.autoConfirmSha256 = true;
    } else if (arg === "--rearm-ttl-seconds") {
      options.rearmTtlSeconds = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--rearm-operator") {
      options.rearmOperator = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--rearm-operator-signature") {
      options.rearmOperatorSignature = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--rearm-reason") {
      options.rearmReason = String(argv[index + 1] || "").trim();
      index += 1;
    }
  }
  return options;
}

function normalizeCommandPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return { ...payload };
}

function parseTimestampMs(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRuntimeAutoLiveEligible(riskControls) {
  if (!riskControls || typeof riskControls !== "object") {
    return false;
  }
  const liveEnabled =
    riskControls.allowLiveTrading === true && riskControls.writeBrokerOrders === true;
  if (!liveEnabled) {
    return false;
  }
  if (riskControls.liveDeactivation?.enabled === true) {
    return false;
  }
  if (riskControls.majorEventLock?.enabled === true) {
    return false;
  }
  const expiresAtMs = parseTimestampMs(riskControls.liveActivation?.expiresAt);
  if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) {
    return false;
  }
  return true;
}

export async function buildCapitalLocalExecutorFinalConfirmation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const execute = options.execute === true;
  const confirmSha256Provided = String(options.confirmSha256 || "")
    .trim()
    .toUpperCase();
  const autoRearm = options.autoRearm === true;
  const autoConfirmSha256 = options.autoConfirmSha256 === true;
  const rearmReason =
    String(options.rearmReason || "").trim() || "local-executor-final-confirmation-auto-rearm";
  const rearmTtlSeconds = String(options.rearmTtlSeconds || "").trim();

  let rearmReport = null;
  let dispatch = await buildCapitalLocalBrokerExecutorDispatchContract({ repoRoot });
  if (execute && autoRearm && dispatch.executor?.armed !== true) {
    rearmReport = await buildCapitalLiveExecutorProfileRearm({
      repoRoot,
      execute: true,
      operator: options.rearmOperator,
      operatorSignature: options.rearmOperatorSignature,
      reason: rearmReason,
      ttlSeconds: rearmTtlSeconds,
    });
    dispatch = await buildCapitalLocalBrokerExecutorDispatchContract({ repoRoot });
  }
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const riskControlsPath = path.join(capitalRoot, "risk-controls.json");
  const riskControls = await readJsonIfExists(riskControlsPath);
  const serviceStatusPath = path.join(capitalRoot, "hft_service_status.json");
  const serviceStatus = await readJsonIfExists(serviceStatusPath);
  const commandFilePath =
    typeof serviceStatus?.commandFile === "string" && serviceStatus.commandFile.trim().length > 0
      ? serviceStatus.commandFile.trim()
      : path.join(capitalRoot, "state", "hft_command.json");
  const reportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-local-executor-final-confirmation-latest.json",
  );
  const panelPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-local-executor-final-confirmation.json",
  );
  const auditLogPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-local-executor-final-confirmation-dispatch.jsonl",
  );

  const blockers = [];
  const runtimeAutoLiveEligible = isRuntimeAutoLiveEligible(riskControls);
  const bypassDispatchPolicyForRuntimeAutoLive = execute && autoRearm && runtimeAutoLiveEligible;
  if (dispatch.status !== READY_STATUS && !bypassDispatchPolicyForRuntimeAutoLive) {
    blockers.push(`dispatch-status:${dispatch.status}`);
  }
  if (
    dispatch.dispatchPolicy !== READY_DISPATCH_POLICY &&
    !bypassDispatchPolicyForRuntimeAutoLive
  ) {
    blockers.push(`dispatch-policy:${dispatch.dispatchPolicy}`);
  }
  if (
    dispatch.operatorPacket?.operatorCanExecute !== true &&
    !bypassDispatchPolicyForRuntimeAutoLive
  ) {
    blockers.push("operator-packet:not-executable");
  }
  if (dispatch.executor?.armed !== true) {
    blockers.push("executor:arm-profile-not-armed");
  }

  const sealedIntentSha256 = String(dispatch.sealedIntentSha256 || "").toUpperCase();
  let confirmSha256Effective = confirmSha256Provided;
  if (execute && autoConfirmSha256 && confirmSha256Effective.length === 0) {
    confirmSha256Effective = sealedIntentSha256;
  }
  if (
    execute &&
    (confirmSha256Effective.length === 0 || confirmSha256Effective !== sealedIntentSha256)
  ) {
    blockers.push("confirm-sha256-mismatch");
  }

  const commandPayload = normalizeCommandPayload(dispatch.dispatchContract?.commandPayload);
  if (Object.keys(commandPayload).length === 0) {
    blockers.push("dispatch-command-payload-missing");
  }

  let sentOrder = false;
  let status = blockers.length === 0 ? "ready_for_local_executor_final_confirmation" : "blocked";
  let executionReceipt = null;

  if (execute && blockers.length === 0) {
    await fs.mkdir(path.dirname(commandFilePath), { recursive: true });
    await fs.writeFile(commandFilePath, `${JSON.stringify(commandPayload, null, 2)}\n`, "utf8");
    sentOrder = true;
    status = "executor_dispatch_command_written";
    executionReceipt = {
      commandFilePath,
      writtenAt: new Date().toISOString(),
      commandSha256: sha256Text(JSON.stringify(commandPayload)),
      sealedIntentSha256,
      source: "local_executor_final_confirmation",
    };
    await appendJsonLine(auditLogPath, {
      schema: "openclaw.capital.local-executor-final-confirmation-dispatch-log.v1",
      generatedAt: executionReceipt.writtenAt,
      status,
      commandFilePath,
      sealedIntentSha256,
      commandPayload,
    });
  }

  const nextSafeTask =
    status === "executor_dispatch_command_written"
      ? "等待券商側回報後，立即重跑 capital:trade:direct:status:check 與 capital:live-readiness:check。"
      : blockers.length === 0
        ? "可使用 --execute --confirm-sha256 <sealedOrderIntentSha256> 進行本地執行器最終確認。"
        : "先清除 dispatch/arm/operator blocker，再重跑 local-executor-dispatch:check。";

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "local_executor_final_confirmation",
    execute,
    sealedOrderIntentSha256: sealedIntentSha256,
    autoRearm,
    autoConfirmSha256,
    confirmSha256Provided,
    confirmSha256Effective,
    rearm: rearmReport
      ? {
          status: rearmReport.status,
          profileBeforeStatus: rearmReport.profileBeforeStatus,
          profileAfterStatus: rearmReport.profileAfterStatus,
          activeProfileWritten: rearmReport.safety?.activeProfileWritten === true,
          blockers: Array.isArray(rearmReport.blockers) ? rearmReport.blockers : [],
          expiresAt: rearmReport.expiresAt,
          machineLine: rearmReport.machineLine,
        }
      : null,
    runtimeAutoLive: {
      eligible: runtimeAutoLiveEligible,
      bypassDispatchPolicyForRuntimeAutoLive,
      riskControlsPath,
      liveEnabled:
        riskControls?.allowLiveTrading === true && riskControls?.writeBrokerOrders === true,
      majorEventLockEnabled: riskControls?.majorEventLock?.enabled === true,
      liveDeactivationEnabled: riskControls?.liveDeactivation?.enabled === true,
      activationExpiresAt: riskControls?.liveActivation?.expiresAt || "",
    },
    dispatch: {
      status: dispatch.status,
      dispatchPolicy: dispatch.dispatchPolicy,
      operatorCanExecute: dispatch.operatorPacket?.operatorCanExecute === true,
      executorArmed: dispatch.executor?.armed === true,
      payloadHash: dispatch.dispatchContract?.payloadHash || "",
    },
    service: {
      status: serviceStatus?.status || "unknown",
      loginStatus: serviceStatus?.loginStatus || "unknown",
      commandFilePath,
    },
    commandPayload,
    executionReceipt,
    blockers,
    safety: {
      sentOrder,
      noLiveOrderSent: sentOrder !== true,
      brokerApiCalled: false,
      brokerWriteAttempted: sentOrder,
      writeBrokerOrders: sentOrder,
      conversationAgentDirectBrokerWrite: false,
      reportOnly: sentOrder !== true,
    },
    paths: {
      reportPath,
      panelPath,
      auditLogPath,
      dispatchReportPath: dispatch.paths?.reportPath || "",
      commandFilePath,
    },
    machineLine: [
      `capitalLocalExecutorFinalConfirmation=${status}`,
      `sha256=${sealedIntentSha256 || "missing"}`,
      `execute=${execute}`,
      `autoRearm=${autoRearm}`,
      `autoConfirm=${autoConfirmSha256}`,
      `runtimeAutoLiveBypass=${bypassDispatchPolicyForRuntimeAutoLive}`,
      `operatorCanExecute=${dispatch.operatorPacket?.operatorCanExecute === true}`,
      `executorArmed=${dispatch.executor?.armed === true}`,
      `dispatchPolicy=${dispatch.dispatchPolicy || "missing"}`,
      `sentOrder=${sentOrder}`,
      `blockers=${blockers.length}`,
    ].join(" "),
    nextSafeTask,
  };

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalLocalExecutorFinalConfirmation({
    repoRoot: process.cwd(),
    execute: options.execute,
    confirmSha256: options.confirmSha256,
    autoRearm: options.autoRearm,
    autoConfirmSha256: options.autoConfirmSha256,
    rearmTtlSeconds: options.rearmTtlSeconds,
    rearmOperator: options.rearmOperator,
    rearmOperatorSignature: options.rearmOperatorSignature,
    rearmReason: options.rearmReason,
  });

  if (options.writeState || options.check) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
  }

  if (
    options.check &&
    (report.safety.brokerApiCalled === true ||
      report.safety.conversationAgentDirectBrokerWrite === true)
  ) {
    throw new Error("CAPITAL_LOCAL_EXECUTOR_FINAL_CONFIRMATION_UNSAFE_WRITE");
  }

  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
