#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";
import { buildCapitalLiveReadinessGate } from "./openclaw-capital-live-readiness-gate.mjs";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";
import { buildCapitalLocalBrokerExecutorDispatchContract } from "./openclaw-capital-local-broker-executor-dispatch-contract.mjs";
import { buildCapitalLocalExecutorFinalConfirmation } from "./openclaw-capital-local-executor-final-confirmation.mjs";

const SCHEMA = "openclaw.capital.live-trading-autopilot-cycle.v1";
const currentFile = fileURLToPath(import.meta.url);

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

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveQuoteFresh(directStatus) {
  const quote = directStatus?.summary?.quote ?? {};
  const a50Fresh = quote.a50Status === "fresh";
  const matrixReady = quote.a50UnblockCondition === "核心必要商品 fresh matched：可回報即時價。";
  return a50Fresh || matrixReady;
}

function pnpmDirCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

export async function runCapitalLiveTradingAutopilotCycle(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const execute = options.execute === true;
  const operator = String(options.operator || "autopilot").trim() || "autopilot";
  const majorEventReason = String(options.majorEventReason || "major_event_guard").trim();
  const reportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-live-trading-autopilot-cycle-latest.json",
  );
  const panelPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-live-trading-autopilot-cycle.json",
  );

  const operatorStatus = await runCapitalLiveTradingOperatorGate({
    action: "status",
    execute: false,
    writeState: false,
  });
  const directStatus = await buildCapitalDirectOperationStatus({ repoRoot });
  const readiness = await buildCapitalLiveReadinessGate({ repoRoot });
  const dispatch = await buildCapitalLocalBrokerExecutorDispatchContract({ repoRoot });

  const capitalRoot = resolveCapitalHftStateDir();
  const riskControlsPath = path.join(capitalRoot, "risk-controls.json");
  const riskControls = await readJsonOptional(riskControlsPath);

  const liveEnabled = operatorStatus?.report?.riskControls?.enabledAfter === true;
  const activationExpired = operatorStatus?.report?.riskControls?.activationExpired === true;
  const majorEventLock =
    riskControls?.majorEventLock?.enabled === true ||
    riskControls?.liveDeactivation?.enabled === true;
  const quoteFresh = resolveQuoteFresh(directStatus);
  const readinessOk = readiness?.status === "ready_for_operator_adapter_review";
  const dispatchReady = dispatch?.status === "ready_for_local_executor_final_confirmation";
  const operatorCanExecute = dispatch?.operatorPacket?.operatorCanExecute === true;
  const executorArmed = dispatch?.executor?.armed === true;
  const noLiveOrderSentBefore = readiness?.safety?.noLiveOrderSent === true;

  const majorEvent = majorEventLock || activationExpired;
  const canAttemptAutoDispatch = liveEnabled && !majorEvent && quoteFresh;
  const shouldAutoTrade =
    liveEnabled &&
    !majorEvent &&
    quoteFresh &&
    readinessOk &&
    dispatchReady &&
    operatorCanExecute &&
    executorArmed &&
    noLiveOrderSentBefore;

  let action = "hold";
  let applyResult = null;
  let finalConfirmation = null;

  if (execute && majorEvent && liveEnabled) {
    applyResult = await runCapitalLiveTradingOperatorGate({
      action: activationExpired ? "reconcile" : "deactivate",
      execute: true,
      writeState: true,
      operator,
      reason: majorEventReason,
    });
    action = activationExpired ? "reconcile_expired_auto_off" : "major_event_auto_off";
  } else if (execute && canAttemptAutoDispatch) {
    finalConfirmation = await buildCapitalLocalExecutorFinalConfirmation({
      repoRoot,
      execute: true,
      autoRearm: true,
      autoConfirmSha256: true,
    });
    action =
      finalConfirmation.status === "executor_dispatch_command_written"
        ? "auto_dispatch_written"
        : finalConfirmation.status === "ready_for_local_executor_final_confirmation"
          ? "auto_dispatch_ready_waiting_next_execute"
          : "auto_dispatch_blocked";
  } else if (majorEvent) {
    action = "major_event_hold";
  } else {
    action = "normal_hold_wait_conditions";
  }

  const sentOrder = finalConfirmation?.safety?.sentOrder === true;
  const noLiveOrderSent = !sentOrder;
  const status =
    action === "auto_dispatch_written"
      ? "executed_dispatch_command_written"
      : majorEvent
        ? "major_event_guarded"
        : execute && canAttemptAutoDispatch && action === "auto_dispatch_ready_waiting_next_execute"
          ? "ready_for_autopilot_execute"
          : shouldAutoTrade
            ? "ready_for_autopilot_execute"
            : "waiting_conditions";

  const blockers = [];
  if (!liveEnabled) {
    blockers.push("live_not_enabled");
  }
  if (majorEventLock) {
    blockers.push("major_event_lock_enabled");
  }
  if (activationExpired) {
    blockers.push("activation_expired");
  }
  if (!quoteFresh) {
    blockers.push("quote_not_fresh");
  }
  if (!readinessOk && !canAttemptAutoDispatch) {
    blockers.push(`readiness_not_ready:${readiness?.status || "unknown"}`);
  }
  if (!dispatchReady && !canAttemptAutoDispatch) {
    blockers.push(`dispatch_not_ready:${dispatch?.status || "unknown"}`);
  }
  if (!operatorCanExecute && !canAttemptAutoDispatch) {
    blockers.push("operator_packet_not_executable");
  }
  if (!executorArmed && !canAttemptAutoDispatch) {
    blockers.push("executor_not_armed");
  }
  if (!noLiveOrderSentBefore) {
    blockers.push("safety_no_live_order_sent_before_false");
  }
  if (finalConfirmation && Array.isArray(finalConfirmation.blockers)) {
    for (const blocker of finalConfirmation.blockers) {
      blockers.push(`final_confirmation:${blocker}`);
    }
  }

  const nextSafeTask =
    status === "executed_dispatch_command_written"
      ? `${pnpmDirCommand(repoRoot, "capital:trade:direct:status:check")} && ${pnpmDirCommand(repoRoot, "capital:live-readiness:check")}`
      : majorEvent
        ? `${pnpmDirCommand(repoRoot, "capital:live-trading:operator:status")} && ${pnpmDirCommand(repoRoot, "capital:live-readiness:check")}`
        : `${pnpmDirCommand(repoRoot, "capital:trade:local-executor:final-confirmation:auto-execute")}（在 execute=true 時啟動）`;

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "auto_trade_normal_major_event_guard",
    execute,
    action,
    majorEvent,
    majorEventLock,
    activationExpired,
    liveEnabled,
    quoteFresh,
    readinessStatus: readiness?.status || "",
    dispatchStatus: dispatch?.status || "",
    operatorCanExecute,
    executorArmed,
    shouldAutoTrade,
    blockers,
    operatorStatus: {
      status: operatorStatus?.report?.status || "",
      enabledAfter: operatorStatus?.report?.riskControls?.enabledAfter === true,
      activationExpiresAt: operatorStatus?.report?.riskControls?.activationExpiresAt || "",
      activationExpired: operatorStatus?.report?.riskControls?.activationExpired === true,
    },
    applyResult: applyResult?.report
      ? {
          action: applyResult.report.action,
          status: applyResult.report.status,
          applied: applyResult.report.applied === true,
          enabledAfter: applyResult.report?.riskControls?.enabledAfter === true,
        }
      : null,
    finalConfirmation: finalConfirmation
      ? {
          status: finalConfirmation.status,
          sealedOrderIntentSha256: finalConfirmation.sealedOrderIntentSha256,
          commandFilePath: finalConfirmation.executionReceipt?.commandFilePath || "",
          commandSha256: finalConfirmation.executionReceipt?.commandSha256 || "",
          sentOrder: finalConfirmation.safety?.sentOrder === true,
        }
      : null,
    safety: {
      sentOrder,
      noLiveOrderSent,
      writeBrokerOrders: sentOrder,
      brokerWriteAttempted: finalConfirmation?.safety?.brokerWriteAttempted === true,
      conversationAgentDirectBrokerWrite: false,
    },
    paths: {
      reportPath,
      panelPath,
      riskControlsPath,
    },
    machineLine: [
      `capitalLiveAutopilot=${status}`,
      `execute=${execute}`,
      `action=${action}`,
      `liveEnabled=${liveEnabled}`,
      `majorEvent=${majorEvent}`,
      `quoteFresh=${quoteFresh}`,
      `readiness=${readiness?.status || "unknown"}`,
      `dispatch=${dispatch?.status || "unknown"}`,
      `operatorCanExecute=${operatorCanExecute}`,
      `executorArmed=${executorArmed}`,
      `sentOrder=${sentOrder}`,
      `blockers=${blockers.length}`,
    ].join(" "),
    nextSafeTask,
  };

  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(reportPath, report);
    await writeJsonWithSha(panelPath, report);
  }

  return report;
}

async function main() {
  const report = await runCapitalLiveTradingAutopilotCycle({
    repoRoot: process.cwd(),
    execute: hasFlag("--execute"),
    writeState: hasFlag("--write-state"),
    check: hasFlag("--check"),
    operator: argValue("--operator", "autopilot"),
    majorEventReason: argValue("--major-event-reason", "major_event_guard"),
  });

  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live trading autopilot cycle failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
