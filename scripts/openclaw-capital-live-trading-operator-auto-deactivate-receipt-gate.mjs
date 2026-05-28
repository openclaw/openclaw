#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";

const SCHEMA = "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1";
const SOURCE_SCHEMA = "openclaw.capital.live-trading-operator-auto-deactivate.v1";
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const SOURCE_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-auto-deactivate-latest.json",
);
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
);

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

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, evidence = {}) {
  return { id, status: passFail(ok), evidence };
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRepoRootPnpmCommand(command) {
  return /^pnpm --dir .+ /u.test(safeString(command));
}

function buildValidationCommands(root) {
  return {
    receiptGate: openclawPnpmCommand(
      root,
      "capital:live-trading:operator:auto-deactivate:receipt:check",
    ),
    autoDeactivate: openclawPnpmCommand(root, "capital:live-trading:operator:auto-deactivate"),
    controlledRun: openclawPnpmCommand(root, "autonomous:controlled:run -- --json"),
  };
}

function buildReceiptState(source) {
  const receipt = source?.operatorActionReceipt ?? null;
  const pendingExecute =
    source?.execute === false &&
    source?.operatorActionRequired === true &&
    safeString(source?.operatorActionAuditId).length > 0 &&
    safeString(source?.operatorActionCommand).length > 0;
  const receiptVerified =
    source?.execute === true &&
    source?.applied === true &&
    source?.status === "deactivated" &&
    receipt?.applied === true &&
    receipt?.riskControlsChanged === true &&
    receipt?.after?.allowLiveTrading === false &&
    receipt?.after?.writeBrokerOrders === false &&
    receipt?.sentOrder === false &&
    receipt?.noOrderWrite === true &&
    safeString(receipt?.rollbackPolicy) === "manual_only_do_not_auto_reenable_live_write";
  return { pendingExecute, receiptVerified, receipt };
}

export async function buildCapitalLiveTradingOperatorAutoDeactivateReceiptGate(options = {}) {
  const root = path.resolve(options.repoRoot ?? repoRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourceReportPath = path.resolve(options.sourceReportPath ?? SOURCE_REPORT_PATH);
  const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
  const source = await readJson(sourceReportPath);
  const validationCommands = buildValidationCommands(root);
  const commandsQualified = Object.values(validationCommands).every(isRepoRootPnpmCommand);
  const { pendingExecute, receiptVerified, receipt } = buildReceiptState(source);
  const noLiveOrderSent =
    source?.sentOrder !== true &&
    source?.safety?.sentOrder !== true &&
    source?.gateReport?.safety?.sentOrder !== true &&
    receipt?.sentOrder !== true;
  const heartbeatExecuteBlocked = source?.operatorActionHeartbeatExecuteAllowed !== true;
  const auditId = safeString(source?.operatorActionAuditId || receipt?.id);
  const receiptMatchesAudit =
    pendingExecute ||
    (receiptVerified && auditId.length > 0 && safeString(receipt?.id) === auditId);
  const checks = [
    check("source:schema", source?.schema === SOURCE_SCHEMA, { schema: source?.schema || "" }),
    check("source:audit-id-present", auditId.length > 0, { auditId }),
    check("source:heartbeat-execute-blocked", heartbeatExecuteBlocked, {
      operatorActionHeartbeatExecuteAllowed: source?.operatorActionHeartbeatExecuteAllowed === true,
    }),
    check("receipt:pending-or-verified", pendingExecute || receiptVerified, {
      pendingExecute,
      receiptVerified,
      sourceStatus: source?.status || "",
      execute: source?.execute === true,
      applied: source?.applied === true,
    }),
    check("receipt:matches-audit", receiptMatchesAudit, {
      auditId,
      receiptId: safeString(receipt?.id),
    }),
    check("commands:repo-root-qualified", commandsQualified, validationCommands),
    check("safety:no-live-order-sent", noLiveOrderSent, {
      sourceSentOrder: source?.sentOrder === true,
      receiptSentOrder: receipt?.sentOrder === true,
    }),
  ];
  const failed = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const status =
    failed.length > 0
      ? "blocked_receipt_gate_incomplete"
      : receiptVerified
        ? "receipt_verified"
        : "pending_explicit_execute_receipt";
  const blockers =
    status === "blocked_receipt_gate_incomplete"
      ? failed
      : status === "pending_explicit_execute_receipt"
        ? ["operator-auto-deactivate:execute-receipt-pending"]
        : [];
  const report = {
    schema: SCHEMA,
    generatedAt,
    status,
    sourceReportPath,
    auditId,
    pendingExplicitExecuteReceipt: status === "pending_explicit_execute_receipt",
    receiptVerified: status === "receipt_verified",
    execute: source?.execute === true,
    applied: source?.applied === true,
    operatorActionRequired: source?.operatorActionRequired === true,
    heartbeatExecuteAllowed: source?.operatorActionHeartbeatExecuteAllowed === true,
    validationCommands,
    checks,
    blockers,
    safety: {
      reportOnly: true,
      noLiveOrderSent,
      sentOrder: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      heartbeatExecuteAllowed: false,
    },
    machineLine: [
      `capitalAutoDeactivateReceipt=${status}`,
      `audit=${auditId || "missing"}`,
      `pendingExplicitExecuteReceipt=${String(status === "pending_explicit_execute_receipt")}`,
      `receiptVerified=${String(status === "receipt_verified")}`,
      `heartbeatExecuteAllowed=false`,
      `noOrderWrite=true`,
      `sentOrder=false`,
    ].join(" "),
    nextSafeTask:
      status === "receipt_verified"
        ? `Receipt verified; rerun ${openclawPnpmCommand(root, "autonomous:controlled:run -- --json")}.`
        : `Waiting for explicit non-heartbeat operator execute, then rerun ${validationCommands.receiptGate}.`,
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
  }
  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const { report } = await buildCapitalLiveTradingOperatorAutoDeactivateReceiptGate({
    reportPath: path.resolve(argValue("--report", DEFAULT_REPORT_PATH)),
    sourceReportPath: path.resolve(argValue("--source-report", SOURCE_REPORT_PATH)),
    writeState: hasFlag("--write-state"),
  });
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital auto-deactivate receipt gate",
        `status=${report.status}`,
        `audit=${report.auditId || "missing"}`,
        `pendingExplicitExecuteReceipt=${report.pendingExplicitExecuteReceipt}`,
        `receiptVerified=${report.receiptVerified}`,
        `noLiveOrderSent=${report.safety.noLiveOrderSent}`,
      ].join("\n") + "\n",
    );
  }
}
