import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const CAPITAL_ROOT =
  process.env.OPENCLAW_CAPITAL_HFT_SERVICE_ROOT || "D:\\群益及元大API\\CapitalHftService";

const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_RISK_CONTROLS_PATH = path.join(CAPITAL_ROOT, "risk-controls.json");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-operator-auto-deactivate-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function sha256File(filePath) {
  try {
    return sha256Text(await fs.readFile(filePath, "utf8"));
  } catch {
    return "";
  }
}

function buildOperatorActionAuditId(value) {
  return `capital-auto-deactivate-${sha256Text(JSON.stringify(value)).slice(0, 20).toLowerCase()}`;
}

async function main() {
  const approvalPath = path.resolve(argValue("--approval", DEFAULT_APPROVAL_PATH));
  const riskControlsPath = path.resolve(argValue("--risk-controls", DEFAULT_RISK_CONTROLS_PATH));
  const reportPath = path.resolve(argValue("--report", DEFAULT_REPORT_PATH));
  const execute = hasFlag("--execute");
  const writeState = hasFlag("--write-state");
  const reason = argValue("--reason", "operator-auto-deactivate");

  const approval = await readJson(approvalPath);
  const operator =
    argValue("--operator", "").trim() ||
    String(approval?.manualApproval?.operator || "").trim() ||
    "OpenClaw Operator";

  const riskControlsBefore = await readJson(riskControlsPath);
  const approvalSha256Before = await sha256File(approvalPath);
  const riskControlsSha256Before = await sha256File(riskControlsPath);

  const { report } = await runCapitalLiveTradingOperatorGate({
    action: "deactivate",
    execute,
    writeState,
    approvalPath,
    riskControlsPath,
    reportPath,
    operator,
    reason,
  });

  const enabledAfter = report?.riskControls?.enabledAfter === true;
  const activationExpired = report?.riskControls?.activationExpired === true;
  const sentOrder = report?.safety?.sentOrder === true;
  const operatorActionRequired =
    !execute && report.status === "ready_to_deactivate" && enabledAfter;
  const operatorActionReason = operatorActionRequired
    ? activationExpired
      ? "expired_live_write_still_enabled"
      : "live_write_still_enabled"
    : "";
  const operatorActionCommand = operatorActionRequired
    ? "pnpm capital:live-trading:operator:auto-deactivate:execute"
    : "";
  const actionAuditCommand =
    operatorActionCommand ||
    (execute && report.applied === true && report.status === "deactivated"
      ? "pnpm capital:live-trading:operator:auto-deactivate:execute"
      : "");
  const actionAuditReason =
    operatorActionReason ||
    (execute && report.applied === true && report.status === "deactivated"
      ? activationExpired
        ? "expired_live_write_still_enabled"
        : "live_write_still_enabled"
      : "");
  const actionAuditEligible = actionAuditCommand.length > 0;
  const operatorActionAuditId = actionAuditEligible
    ? buildOperatorActionAuditId({
        schema: "openclaw.capital.live-trading-operator-auto-deactivate.action.v1",
        action: "deactivate",
        approvalPath,
        riskControlsPath,
        approvalSha256Before,
        riskControlsSha256Before,
        activationExpiresAt: String(report?.riskControls?.activationExpiresAt || ""),
        operatorActionCommand: actionAuditCommand,
        operatorActionReason: actionAuditReason,
      })
    : "";
  const riskControlsSha256After = await sha256File(riskControlsPath);
  const riskControlsAfter = await readJson(riskControlsPath);
  const operatorActionReceipt =
    execute && report.applied === true && report.status === "deactivated"
      ? {
          id: operatorActionAuditId,
          command: actionAuditCommand,
          reason: actionAuditReason,
          executeReason: reason,
          applied: true,
          status: report.status,
          approvalSha256Before,
          riskControlsSha256Before,
          riskControlsSha256After,
          riskControlsChanged: riskControlsSha256Before !== riskControlsSha256After,
          before: {
            allowLiveTrading: riskControlsBefore?.allowLiveTrading === true,
            writeBrokerOrders: riskControlsBefore?.writeBrokerOrders === true,
            liveActivationEnabled: riskControlsBefore?.liveActivation?.enabled === true,
            liveDeactivationEnabled: riskControlsBefore?.liveDeactivation?.enabled === true,
          },
          after: {
            allowLiveTrading: riskControlsAfter?.allowLiveTrading === true,
            writeBrokerOrders: riskControlsAfter?.writeBrokerOrders === true,
            liveActivationEnabled: riskControlsAfter?.liveActivation?.enabled === true,
            liveDeactivationEnabled: riskControlsAfter?.liveDeactivation?.enabled === true,
          },
          rollbackPolicy: "manual_only_do_not_auto_reenable_live_write",
          sentOrder,
          noOrderWrite: !sentOrder,
        }
      : null;

  const wrapper = {
    schema: "openclaw.capital.live-trading-operator-auto-deactivate.v1",
    generatedAt: new Date().toISOString(),
    execute,
    approvalPath,
    riskControlsPath,
    operator,
    status: report.status,
    applied: report.applied,
    blockerCode: report.blockerCode || "",
    blockers: Array.isArray(report.blockers) ? report.blockers : [],
    enabledAfter,
    activationExpired,
    activationExpiresAt: String(report?.riskControls?.activationExpiresAt || ""),
    sentOrder,
    noOrderWrite: !sentOrder,
    operatorActionRequired,
    operatorActionCommand,
    operatorActionReason,
    operatorActionAuditId,
    operatorActionRequiresExplicitExecute: operatorActionRequired,
    operatorActionHeartbeatExecuteAllowed: false,
    operatorActionAudit: operatorActionRequired
      ? {
          id: operatorActionAuditId,
          command: operatorActionCommand,
          reason: operatorActionReason,
          approvalSha256Before,
          riskControlsSha256Before,
          requiresExplicitExecute: true,
          heartbeatExecuteAllowed: false,
        }
      : null,
    operatorActionReceipt,
    nextSafeTask: report.nextSafeTask || "",
    riskControls: report.riskControls ?? null,
    safety: report.safety ?? null,
    gateReport: report,
  };

  if (writeState) {
    await writeJsonWithSha(reportPath, wrapper);
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(wrapper, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading auto-deactivate",
        `status=${wrapper.status}`,
        `applied=${wrapper.applied}`,
        `enabledAfter=${wrapper.enabledAfter}`,
        `activationExpired=${wrapper.activationExpired}`,
        `blockerCode=${wrapper.blockerCode || "none"}`,
        `sentOrder=${wrapper.sentOrder}`,
        `nextSafeTask=${wrapper.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
