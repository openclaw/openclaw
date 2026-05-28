#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-readiness-simulation-latest.json",
);

const ALLOWED_STATUSES = new Set([
  "blocked_live_readiness_incomplete",
  "ready_for_operator_execution_review",
]);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const issues = [];
let report;

try {
  report = await readJson(REPORT_PATH);
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.live-readiness-simulation.v1") {
    issues.push(`schema=${report.schema ?? ""}`);
  }
  if (!ALLOWED_STATUSES.has(report.status)) {
    issues.push(`status=${report.status ?? ""}`);
  }
  if (report.simulationRuns !== 500) {
    issues.push(`simulationRuns=${report.simulationRuns ?? ""}`);
  }
  if (
    report.safety?.reportOnly !== true ||
    report.safety?.simulatedOnly !== true ||
    report.safety?.allowLiveTrading !== false ||
    report.safety?.liveTradingEnabled !== false ||
    report.safety?.writeBrokerOrders !== false ||
    report.safety?.brokerWriteAttempted !== false ||
    report.safety?.sentOrder !== false ||
    report.safety?.noLiveOrderSent !== true ||
    report.safety?.no_live_order_sent !== true
  ) {
    issues.push(`safety=${JSON.stringify(report.safety)}`);
  }
  if (
    report.completion?.falseAccepted !== 0 ||
    report.completion?.sentOrder !== false ||
    report.completion?.noLiveOrderSent !== true ||
    report.completion?.acceptedRuns + report.completion?.blockedRuns !== 500
  ) {
    issues.push(`completion=${JSON.stringify(report.completion)}`);
  }
  if (!Array.isArray(report.gateChecklist) || report.gateChecklist.length < 10) {
    issues.push("gateChecklist=missing");
  }
  if (report.sourceReports?.coreProductMatrix?.found !== true) {
    issues.push(
      `coreProductMatrix source=${JSON.stringify(report.sourceReports?.coreProductMatrix)}`,
    );
  }
  if (report.sourceReports?.currentPaperIntents?.found !== true) {
    issues.push(
      `currentPaperIntents source=${JSON.stringify(report.sourceReports?.currentPaperIntents)}`,
    );
  }
  if (report.sourceReports?.adapterApplyReceipt?.found !== true) {
    issues.push(
      `adapterApplyReceipt source=${JSON.stringify(report.sourceReports?.adapterApplyReceipt)}`,
    );
  }
  if (report.quoteFreshness?.coreProductMatrix?.productCount < 1) {
    issues.push(
      `coreProductMatrix quoteFreshness=${JSON.stringify(report.quoteFreshness?.coreProductMatrix)}`,
    );
  }
  if (typeof report.quoteFreshness?.currentPaperIntents?.generatedIntentCount !== "number") {
    issues.push(
      `currentPaperIntents quoteFreshness=${JSON.stringify(report.quoteFreshness?.currentPaperIntents)}`,
    );
  }
  if (!Array.isArray(report.simulationLog) || report.simulationLog.length !== 500) {
    issues.push(`simulationLog=${report.simulationLog?.length ?? ""}`);
  }
  if (report.status === "blocked_live_readiness_incomplete") {
    if (report.operatorCanExecute !== false) {
      issues.push(`operatorCanExecute=${report.operatorCanExecute}`);
    }
    if (!Array.isArray(report.incompleteChecklist) || report.incompleteChecklist.length === 0) {
      issues.push("incompleteChecklist=empty");
    }
    if (report.completion?.blockedRuns !== 500 || report.completion?.acceptedRuns !== 0) {
      issues.push(`blockedRuns=${report.completion?.blockedRuns ?? ""}`);
    }
  }
  if (!String(report.machineLine ?? "").includes("capitalLiveReadinessSimulation=")) {
    issues.push("machineLine=missing");
  }
  if (!String(report.machineLine ?? "").includes("noLiveOrderSent=true")) {
    issues.push("machineLine noLiveOrderSent missing");
  }
  if (!String(report.nextSafeTask ?? "").trim()) {
    issues.push("nextSafeTask=missing");
  }
  if (
    report.commandSurface?.schema !== "openclaw.command-surface.repo-root-pnpm.v1" ||
    report.commandSurface?.repoRoot !== process.cwd() ||
    report.commandSurface?.noPkgManifestAvoided !== true ||
    !String(report.nextSafeTask ?? "").includes(`pnpm --dir ${process.cwd()}`) ||
    !Array.isArray(report.nextCommands) ||
    report.nextCommands.some((command) => !String(command).includes(`pnpm --dir ${process.cwd()}`))
  ) {
    issues.push(`commandSurface=${JSON.stringify(report.commandSurface ?? null)}`);
  }
  const coreProductsCommand = openclawPnpmCommand(
    process.cwd(),
    "capital:quote:core-products:check",
  );
  if (
    report.status === "blocked_live_readiness_incomplete" &&
    report.quoteFreshness?.coreProductMatrix?.status === "blocked" &&
    !report.nextCommands?.includes(coreProductsCommand)
  ) {
    issues.push(`core product command missing: ${coreProductsCommand}`);
  }
  if (!String(report.sealedOrderIntent?.sha256 ?? "").trim()) {
    issues.push("sealedOrderIntent.sha256=missing");
  }
  if ((report.externalBrokerAdapter?.ack?.canarySentOrder ?? null) === true) {
    issues.push("adapter canary sent an order");
  }
  const applyReceiptGate = report.gateChecklist?.find(
    (gate) => gate?.id === "adapter:apply-receipt-verified",
  );
  if (!applyReceiptGate) {
    issues.push("adapter apply receipt gate missing");
  } else if (
    report.externalBrokerAdapter?.applyReceipt?.status === "pending_operator_apply" &&
    !report.incompleteChecklist?.some((gate) => gate?.id === "adapter:apply-receipt-verified")
  ) {
    issues.push("adapter apply receipt pending gate not incomplete");
  }
  if (
    report.externalBrokerAdapter?.applyReceipt?.status === "pending_operator_apply" &&
    !String(report.nextSafeTask ?? "").includes("capital:trade:adapter-ack-apply-receipt:check")
  ) {
    issues.push(`adapter apply receipt nextSafeTask=${report.nextSafeTask ?? ""}`);
  }
  for (const requiredPath of [
    report.paths?.reportPath,
    report.paths?.markdownPath,
    report.paths?.panelPath,
  ]) {
    if (!requiredPath || !(await exists(requiredPath))) {
      issues.push(`path missing: ${requiredPath ?? "<missing>"}`);
    }
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_LIVE_READINESS_SIMULATION_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_LIVE_READINESS_SIMULATION_CHECK=OK status=${report.status} runs=${report.simulationRuns} incomplete=${report.incompleteCount} operatorCanExecute=${report.operatorCanExecute} noLiveOrderSent=${report.safety.noLiveOrderSent}\n`,
  );
}
