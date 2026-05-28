import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-human-approval-request-latest.json",
);
const DEFAULT_MD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-human-approval-request-latest.md",
);

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function parseArgs(argv) {
  const options = {
    action: "request",
    approvalPath: DEFAULT_APPROVAL_PATH,
    output: DEFAULT_REPORT_PATH,
    markdown: DEFAULT_MD_PATH,
    operator: "",
    rollbackPlan: "",
    token: "",
    writeState: false,
    writeApproval: false,
    json: false,
    check: false,
    confirmLive: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--action") {
      options.action = argv[index + 1] || options.action;
      index += 1;
    } else if (arg === "--approval") {
      options.approvalPath = argv[index + 1] || options.approvalPath;
      index += 1;
    } else if (arg === "--output") {
      options.output = argv[index + 1] || options.output;
      index += 1;
    } else if (arg === "--markdown") {
      options.markdown = argv[index + 1] || options.markdown;
      index += 1;
    } else if (arg === "--operator") {
      options.operator = argv[index + 1] || options.operator;
      index += 1;
    } else if (arg === "--rollback-plan") {
      options.rollbackPlan = argv[index + 1] || options.rollbackPlan;
      index += 1;
    } else if (arg === "--token") {
      options.token = argv[index + 1] || options.token;
      index += 1;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--write-approval") {
      options.writeApproval = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--confirm-live") {
      options.confirmLive = true;
    }
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function buildApprovalToken({ approval, approvalPath }) {
  const accounts = uniqueNonEmptyStrings(approval.accountAllowlist);
  const seed = JSON.stringify({
    schema: approval.schema || "",
    approvalPath: path.resolve(approvalPath),
    accounts,
    accountAllowlistSource: approval.accountAllowlistSource || "",
  });
  return `approve-capital-live-${sha256Text(seed).slice(0, 20).toLowerCase()}`;
}

function buildRequest({ approval, approvalPath, outputPath, markdownPath }) {
  const accounts = uniqueNonEmptyStrings(approval.accountAllowlist);
  const token = buildApprovalToken({ approval, approvalPath });
  const blockers = [];
  if (accounts.length === 0) {
    blockers.push("approval:account-allowlist-empty");
  }
  if (approval.safety?.allowLiveTrading === true || approval.safety?.writeBrokerOrders === true) {
    blockers.push("approval:safety-live-write-must-remain-false");
  }
  return {
    schema: "openclaw.capital.live-trading-human-approval-request.v1",
    generatedAt: new Date().toISOString(),
    status: blockers.length > 0 ? "blocked" : "pending_manual_human_approval",
    approvalPath: path.resolve(approvalPath),
    reportPath: path.resolve(outputPath),
    markdownPath: path.resolve(markdownPath),
    approvalToken: token,
    approvalTokenSha256: sha256Text(token),
    accountAllowlist: accounts,
    checklist: {
      verifyAccountAllowlist: accounts.length > 0,
      verifyQuoteFreshness: approval.reviewChecklist?.quoteFreshnessVerified === true,
      verifyPositionQuery: approval.reviewChecklist?.positionQueryVerified === true,
      verifyOrderModeDryRun: approval.reviewChecklist?.orderModeDryRunVerified === true,
      requireRollbackPlan: true,
      requireKillSwitch: true,
      requireManualOperatorName: true,
    },
    safety: {
      requestOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      doesNotSendOrder: true,
      doesNotEnableBrokerWrite: true,
    },
    commands: {
      approveExample: `node scripts/openclaw-capital-live-trading-human-approval.mjs --action approve --operator "<人工核准者>" --rollback-plan "<回滾方式>" --token ${token} --write-approval --write-state --json`,
      denyExample: `node scripts/openclaw-capital-live-trading-human-approval.mjs --action deny --operator "<人工核准者>" --token ${token} --write-approval --write-state --json`,
    },
    blockers,
    nextSafeTask:
      "人工確認 accountAllowlist、kill switch 與 rollback plan 後，用 approvalToken 執行 approve；仍不會啟用 allowLiveTrading/writeBrokerOrders。",
  };
}

function renderMarkdown(report) {
  const accounts = report.accountAllowlist.map((account) => `- ${account}`).join("\n");
  return [
    "# Capital Live Trading Human Approval Request",
    "",
    `- status: ${report.status}`,
    `- approvalToken: ${report.approvalToken}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    "",
    "## Account Allowlist",
    accounts || "- <empty>",
    "",
    "## Approve Command",
    "```powershell",
    report.commands.approveExample,
    "```",
    "",
    "## Deny Command",
    "```powershell",
    report.commands.denyExample,
    "```",
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

function nextApproval({
  approval,
  action,
  operator,
  rollbackPlan,
  token,
  approvalPath,
  confirmLive = false,
}) {
  const expectedToken = buildApprovalToken({ approval, approvalPath });
  const normalizedAction = String(action || "").toLowerCase();
  const blockers = [];
  if (!["approve", "deny", "request"].includes(normalizedAction)) {
    blockers.push("approval:unknown-action");
  }
  if (!operator.trim()) {
    blockers.push("approval:operator-required");
  }
  if (token !== expectedToken) {
    blockers.push("approval:token-mismatch");
  }
  if (normalizedAction === "approve" && !rollbackPlan.trim()) {
    blockers.push("approval:rollback-plan-required");
  }
  const approved = normalizedAction === "approve" && blockers.length === 0;
  const denied = normalizedAction === "deny" && blockers.length === 0;
  const currentChecklist =
    approval.reviewChecklist && typeof approval.reviewChecklist === "object"
      ? approval.reviewChecklist
      : {};
  const updatedApproval = {
    ...approval,
    humanApproved: approved,
    manualAccountReviewRequired: !(approved || denied),
    approvalStatus: approved
      ? "manual_approved_live_review_pending"
      : denied
        ? "manual_denied_live_review"
        : approval.approvalStatus || "template_pending_manual_review",
    killSwitch: approved,
    rollbackPlan: approved ? rollbackPlan.trim() : "",
    reviewChecklist: {
      ...currentChecklist,
      manualOperatorConfirmed: approved,
      manualApprovalAction: normalizedAction,
    },
    safety: {
      ...(approval.safety || {}),
      // 只有 approve 動作 + --confirm-live flag 才開啟 live（需人工確認）
      allowLiveTrading: approved && confirmLive === true,
      writeBrokerOrders: approved && confirmLive === true,
      sentOrder: false,
      manualEditRequired: !(approved && confirmLive === true),
    },
    manualApproval: {
      action: normalizedAction,
      operator: operator.trim(),
      tokenSha256: sha256Text(token),
      approvedAt: approved ? new Date().toISOString() : "",
      deniedAt: denied ? new Date().toISOString() : "",
      grantsLiveTrading: approved && confirmLive === true,
      grantsBrokerWrite: approved && confirmLive === true,
      sentOrder: false,
    },
  };
  return { updatedApproval, blockers, expectedToken };
}

export async function runCapitalLiveTradingHumanApproval(options = {}) {
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const outputPath = path.resolve(options.output || DEFAULT_REPORT_PATH);
  const markdownPath = path.resolve(options.markdown || DEFAULT_MD_PATH);
  const action = options.action || "request";
  const approval = await readJson(approvalPath);
  const request = buildRequest({ approval, approvalPath, outputPath, markdownPath });
  if (action === "request") {
    if (options.writeState === true) {
      await writeJsonWithSha(outputPath, request);
      await writeTextWithSha(markdownPath, renderMarkdown(request));
    }
    return request;
  }

  const { updatedApproval, blockers, expectedToken } = nextApproval({
    approval,
    action,
    operator: options.operator || "",
    rollbackPlan: options.rollbackPlan || "",
    token: options.token || "",
    approvalPath,
    confirmLive: options.confirmLive === true,
  });
  const canWrite = blockers.length === 0 && options.writeApproval === true;
  if (canWrite) {
    await writeJsonWithSha(approvalPath, updatedApproval);
  }
  const report = {
    ...request,
    status:
      blockers.length > 0
        ? "blocked"
        : canWrite
          ? `manual_${action}_written`
          : `manual_${action}_ready`,
    action,
    expectedTokenSha256: sha256Text(expectedToken),
    approvalWrite: {
      requested: options.writeApproval === true,
      applied: canWrite,
      writesProductionApprovalFile: approvalPath === DEFAULT_APPROVAL_PATH,
      humanApproved: updatedApproval.humanApproved === true,
      killSwitch: updatedApproval.killSwitch === true,
      rollbackPlanFilled:
        typeof updatedApproval.rollbackPlan === "string" &&
        updatedApproval.rollbackPlan.trim().length > 0,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
    },
    safety: {
      ...request.safety,
      requestOnly: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      doesNotSendOrder: true,
      doesNotEnableBrokerWrite: true,
    },
    blockers,
    nextSafeTask:
      blockers.length > 0
        ? "先修正人工核准欄位、operator、rollbackPlan 或 token mismatch。"
        : "人工核准狀態已可寫入；下一步重跑 approval/promotion gate，但仍不啟用 live/write/order。",
  };
  if (options.writeState === true) {
    await writeJsonWithSha(outputPath, report);
    await writeTextWithSha(markdownPath, renderMarkdown(report));
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalLiveTradingHumanApproval(options);
  if (options.check && report.status === "blocked") {
    throw new Error(
      `CAPITAL_LIVE_TRADING_HUMAN_APPROVAL_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `status=${report.status}`,
      `approvalToken=${report.approvalToken}`,
      "live/write/order=OFF",
      `nextSafeTask=${report.nextSafeTask}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
