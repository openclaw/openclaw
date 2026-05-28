import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "openclaw-capital-live-trading-operator-gate-latest.json",
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

function parseIso(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildExpectedApprovalToken(approval, approvalPath) {
  const accounts = (Array.isArray(approval.accountAllowlist) ? approval.accountAllowlist : [])
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const seed = JSON.stringify({
    schema: approval.schema || "",
    approvalPath: path.resolve(approvalPath),
    accounts,
    accountAllowlistSource: approval.accountAllowlistSource || "",
  });
  return `approve-capital-live-${sha256Text(seed).slice(0, 20).toLowerCase()}`;
}

function normalizeAction(action) {
  const value = String(action || "status")
    .trim()
    .toLowerCase();
  return ["status", "activate", "deactivate", "reconcile"].includes(value) ? value : "status";
}

function buildBaseSafety() {
  return {
    sentOrder: false,
    externalWriteEnabled: false,
    brokerWriteFileOnly: true,
    loginAttemptedByThisScript: false,
  };
}

export async function runCapitalLiveTradingOperatorGate(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const action = normalizeAction(options.action ?? "status");
  const execute = options.execute === true;
  const ttlMinutesRaw = Number.parseInt(String(options.ttlMinutes ?? 60), 10);
  const ttlMinutes = Number.isFinite(ttlMinutesRaw) && ttlMinutesRaw > 0 ? ttlMinutesRaw : 60;
  const operator = String(options.operator ?? "").trim();
  const reason = String(options.reason ?? "").trim() || "operator-approved-live-enable";
  const token = String(options.token ?? "").trim();

  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const riskControlsPath = path.resolve(options.riskControlsPath || DEFAULT_RISK_CONTROLS_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);

  const [approval, riskControls] = await Promise.all([
    readJson(approvalPath),
    readJson(riskControlsPath),
  ]);

  const expectedToken = buildExpectedApprovalToken(approval, approvalPath);
  const enabledBefore =
    riskControls.allowLiveTrading === true && riskControls.writeBrokerOrders === true;
  const activationExpiresAt = parseIso(riskControls?.liveActivation?.expiresAt);
  const activationExpired =
    Number.isFinite(activationExpiresAt) && now.getTime() >= activationExpiresAt;

  const blockers = [];
  const checks = [];

  if (action === "activate") {
    const humanApproved = approval.humanApproved === true;
    const killSwitch = approval.killSwitch === true;
    const hasRollbackPlan =
      typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0;
    const actionApproved =
      String(approval?.manualApproval?.action || "").toLowerCase() === "approve";
    const tokenMatched = token.length > 0 && token === expectedToken;
    const hasOperator = operator.length > 0;

    checks.push(
      { id: "approval:human-approved", ok: humanApproved },
      { id: "approval:kill-switch", ok: killSwitch },
      { id: "approval:rollback-plan", ok: hasRollbackPlan },
      { id: "approval:manual-action-approve", ok: actionApproved },
      { id: "approval:token-match", ok: tokenMatched },
      { id: "approval:operator-present", ok: hasOperator },
    );

    if (!humanApproved) {
      blockers.push("approval:human-approved");
    }
    if (!killSwitch) {
      blockers.push("approval:kill-switch");
    }
    if (!hasRollbackPlan) {
      blockers.push("approval:rollback-plan");
    }
    if (!actionApproved) {
      blockers.push("approval:manual-action-approve");
    }
    if (!tokenMatched) {
      blockers.push("approval:token-match");
    }
    if (!hasOperator) {
      blockers.push("approval:operator-present");
    }
  }

  const shouldAutoDeactivate = action === "reconcile" && enabledBefore && activationExpired;
  const canActivate = action === "activate" && blockers.length === 0;

  let applied = false;
  let status = enabledBefore ? "live_enabled" : "live_disabled";
  let nextSafeTask = "維持目前狀態。";
  const updatedRisk = { ...riskControls };

  if (action === "activate") {
    if (!canActivate) {
      status = "blocked";
      nextSafeTask = "補齊 approval/token/operator 後再執行 activate。";
    } else if (!execute) {
      status = "ready_to_activate";
      nextSafeTask = "加上 --execute 套用 live 開關。";
    } else {
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
      updatedRisk.allowLiveTrading = true;
      updatedRisk.writeBrokerOrders = true;
      updatedRisk.liveActivation = {
        enabled: true,
        activatedAt: now.toISOString(),
        expiresAt,
        ttlMinutes,
        operator,
        reason,
        source: "openclaw-capital-live-trading-operator-gate",
        approvalTokenSha256: sha256Text(token),
      };
      updatedRisk.liveDeactivation = {
        enabled: false,
      };
      await writeJsonWithSha(riskControlsPath, updatedRisk);
      applied = true;
      status = "activated";
      nextSafeTask = "執行策略監控；到期前請主動 deactivate，或跑 reconcile 自動回關。";
    }
  } else if (action === "deactivate") {
    if (!execute) {
      status = enabledBefore ? "ready_to_deactivate" : "live_disabled";
      nextSafeTask = enabledBefore ? "加上 --execute 套用關閉。" : "目前已是關閉狀態。";
    } else {
      updatedRisk.allowLiveTrading = false;
      updatedRisk.writeBrokerOrders = false;
      updatedRisk.liveDeactivation = {
        enabled: true,
        deactivatedAt: now.toISOString(),
        operator: operator || "operator",
        reason: reason || "operator-deactivate-live",
        source: "openclaw-capital-live-trading-operator-gate",
      };
      if (updatedRisk.liveActivation && typeof updatedRisk.liveActivation === "object") {
        updatedRisk.liveActivation.enabled = false;
      }
      await writeJsonWithSha(riskControlsPath, updatedRisk);
      applied = true;
      status = "deactivated";
      nextSafeTask = "已回到 paper-only，可重跑 service-status/readiness 驗證。";
    }
  } else if (action === "reconcile") {
    if (!shouldAutoDeactivate) {
      status = enabledBefore ? "live_enabled" : "live_disabled";
      nextSafeTask = enabledBefore
        ? "目前未到期；可持續監控或主動 deactivate。"
        : "目前已關閉，無需自動回關。";
    } else if (!execute) {
      status = "expired_pending_auto_deactivate";
      nextSafeTask = "加上 --execute 執行到期自動回關。";
    } else {
      updatedRisk.allowLiveTrading = false;
      updatedRisk.writeBrokerOrders = false;
      updatedRisk.liveDeactivation = {
        enabled: true,
        deactivatedAt: now.toISOString(),
        operator: "auto-expiry-guard",
        reason: "activation_ttl_expired",
        source: "openclaw-capital-live-trading-operator-gate",
      };
      if (updatedRisk.liveActivation && typeof updatedRisk.liveActivation === "object") {
        updatedRisk.liveActivation.enabled = false;
      }
      await writeJsonWithSha(riskControlsPath, updatedRisk);
      applied = true;
      status = "expired_auto_deactivated";
      nextSafeTask = "TTL 到期已自動回關，維持 paper-only。";
    }
  } else {
    status = enabledBefore ? "live_enabled" : "live_disabled";
    nextSafeTask = enabledBefore
      ? "可跑 reconcile 監控到期，或手動 deactivate。"
      : "若要開啟請跑 activate。";
  }

  const latestRisk = applied ? updatedRisk : riskControls;
  const enabledAfter =
    latestRisk.allowLiveTrading === true && latestRisk.writeBrokerOrders === true;
  const expiresAtAfter = parseIso(latestRisk?.liveActivation?.expiresAt);
  const expiredAfter = Number.isFinite(expiresAtAfter) && now.getTime() >= expiresAtAfter;

  const report = {
    schema: "openclaw.capital.live-trading-operator-gate.v1",
    generatedAt: now.toISOString(),
    action,
    execute,
    status,
    applied,
    blockerCode: blockers.length > 0 ? "LIVE_OPERATOR_PRECONDITIONS_FAILED" : "",
    blockers,
    checks,
    approval: {
      approvalPath,
      expectedTokenSha256: sha256Text(expectedToken),
      humanApproved: approval.humanApproved === true,
      approvalStatus: approval.approvalStatus || "",
      killSwitch: approval.killSwitch === true,
      hasRollbackPlan:
        typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0,
      manualApprovalAction: String(approval?.manualApproval?.action || ""),
    },
    riskControls: {
      path: riskControlsPath,
      enabledBefore,
      enabledAfter,
      allowLiveTrading: latestRisk.allowLiveTrading === true,
      writeBrokerOrders: latestRisk.writeBrokerOrders === true,
      activationExpiresAt: latestRisk?.liveActivation?.expiresAt || "",
      activationExpired: expiredAfter,
    },
    safety: {
      ...buildBaseSafety(),
      liveTradingEnabled: latestRisk.allowLiveTrading === true,
      writeBrokerOrders: latestRisk.writeBrokerOrders === true,
      sentOrder: false,
    },
    nextSafeTask,
  };

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalLiveTradingOperatorGate({
    action: argValue("--action", "status"),
    approvalPath: argValue("--approval", DEFAULT_APPROVAL_PATH),
    riskControlsPath: argValue("--risk-controls", DEFAULT_RISK_CONTROLS_PATH),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    ttlMinutes: argValue("--ttl-min", "60"),
    operator: argValue("--operator", ""),
    reason: argValue("--reason", ""),
    token: argValue("--token", ""),
    execute: hasFlag("--execute"),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading operator gate",
        `status=${result.report.status}`,
        `applied=${result.report.applied}`,
        `enabledAfter=${result.report.riskControls.enabledAfter}`,
        `blockerCode=${result.report.blockerCode || "none"}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
