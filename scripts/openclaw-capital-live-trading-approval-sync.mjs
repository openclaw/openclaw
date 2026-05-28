import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_HFT_STATUS_PATH = "D:\\群益及元大API\\CapitalHftService\\hft_service_status.json";

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = typeof value === "string" ? value.trim() : "";
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function sameStringArray(left, right) {
  const a = uniqueNonEmptyStrings(left);
  const b = uniqueNonEmptyStrings(right);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function hasRollbackPlan(approval) {
  return typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0;
}

function buildSyncedApproval({ approval, hftStatus, now = new Date() }) {
  const detectedAccounts = uniqueNonEmptyStrings(hftStatus.accounts);
  const existingAccounts = uniqueNonEmptyStrings(approval.accountAllowlist);
  const sourceHasAccounts = detectedAccounts.length > 0;
  const accounts = sourceHasAccounts ? detectedAccounts : existingAccounts;
  const generatedAt = now.toISOString();
  const reviewChecklist =
    approval.reviewChecklist && typeof approval.reviewChecklist === "object"
      ? approval.reviewChecklist
      : {};
  const safety = approval.safety && typeof approval.safety === "object" ? approval.safety : {};
  const keepExistingManualState = !sourceHasAccounts;
  const preserveManualApproval =
    approval.humanApproved === true &&
    approval.killSwitch === true &&
    hasRollbackPlan(approval) &&
    reviewChecklist.manualOperatorConfirmed === true &&
    sameStringArray(approval.accountAllowlist, accounts);

  return {
    approval: {
      ...approval,
      humanApproved: keepExistingManualState
        ? approval.humanApproved === true
        : preserveManualApproval,
      approvalStatus: keepExistingManualState
        ? approval.approvalStatus || "template_pending_manual_review"
        : preserveManualApproval
          ? approval.approvalStatus || "manual_approved_live_review_pending"
          : "template_pending_manual_review",
      accountAllowlist: accounts,
      accountAllowlistSource: sourceHasAccounts
        ? "auto_detected_from_hft_service_status"
        : approval.accountAllowlistSource || "manual_or_previous_allowlist",
      accountAllowlistSyncedAt: generatedAt,
      autoDetectedAccountCount: detectedAccounts.length,
      manualAccountReviewRequired: keepExistingManualState
        ? approval.manualAccountReviewRequired === true
        : !preserveManualApproval,
      killSwitch: keepExistingManualState ? approval.killSwitch === true : preserveManualApproval,
      rollbackPlan: keepExistingManualState
        ? typeof approval.rollbackPlan === "string"
          ? approval.rollbackPlan
          : ""
        : preserveManualApproval && typeof approval.rollbackPlan === "string"
          ? approval.rollbackPlan
          : "",
      reviewChecklist: {
        ...reviewChecklist,
        manualOperatorConfirmed: keepExistingManualState
          ? reviewChecklist.manualOperatorConfirmed === true
          : preserveManualApproval,
      },
      safety: {
        ...safety,
        allowLiveTrading: false,
        writeBrokerOrders: false,
        sentOrder: false,
        createdByAutomation: true,
        manualEditRequired: true,
      },
    },
    accounts,
    sourceHasAccounts,
    usedExistingAllowlistFallback: !sourceHasAccounts && existingAccounts.length > 0,
    generatedAt,
    preserveManualApproval,
  };
}

export async function syncCapitalLiveTradingApproval(options = {}) {
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const hftStatusPath = path.resolve(options.hftStatusPath || DEFAULT_HFT_STATUS_PATH);
  const approval = await readJson(approvalPath);
  const hftStatus = await readJson(hftStatusPath);
  const {
    approval: syncedApproval,
    accounts,
    sourceHasAccounts,
    usedExistingAllowlistFallback,
    generatedAt,
    preserveManualApproval,
  } = buildSyncedApproval({
    approval,
    hftStatus,
    now: options.now,
  });

  if (options.writeState === true) {
    await writeJson(approvalPath, syncedApproval);
  }

  return {
    approval: syncedApproval,
    report: {
      schema: "openclaw.capital.live-trading-approval-sync.v1",
      generatedAt,
      status: sourceHasAccounts
        ? accounts.length > 0
          ? "synced"
          : "blocked_no_accounts"
        : usedExistingAllowlistFallback
          ? "synced_with_existing_allowlist_fallback"
          : "blocked_no_accounts",
      approvalPath,
      hftStatusPath,
      sourceStatus: hftStatus.status ?? "",
      sourceLoginStatus: hftStatus.loginStatus ?? "",
      sourceLoginMethod: hftStatus.loginMethod ?? "",
      accountAllowlistCount: accounts.length,
      humanApproved: syncedApproval.humanApproved === true,
      preservedManualApproval: preserveManualApproval,
      killSwitch: syncedApproval.killSwitch === true,
      safety: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
        sentOrder: false,
      },
      nextSafeTask: sourceHasAccounts
        ? accounts.length > 0
          ? preserveManualApproval
            ? "帳號 allowlist 已同步且保留有效人工核准；仍需 promotion gate 全通過後才可進入真單人工審查。"
            : "帳號 allowlist 已自動同步；仍需人工審查 humanApproved、killSwitch、rollbackPlan，真單保持 blocked。"
          : "HFT 服務狀態未回傳 accounts；先恢復登入/帳號查詢後重跑同步。"
        : usedExistingAllowlistFallback
          ? "來源 accounts 暫時為空；已保留既有 allowlist 與人工核准，不覆蓋成模板。"
          : "HFT 服務狀態未回傳 accounts 且無既有 allowlist；先恢復登入/帳號查詢後重跑同步。",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await syncCapitalLiveTradingApproval({
    approvalPath: argValue("--approval", DEFAULT_APPROVAL_PATH),
    hftStatusPath: argValue("--hft-status", DEFAULT_HFT_STATUS_PATH),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading approval sync",
        `status=${result.report.status}`,
        `accountAllowlistCount=${result.report.accountAllowlistCount}`,
        `humanApproved=${result.report.humanApproved}`,
        "live/write/order=OFF",
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
