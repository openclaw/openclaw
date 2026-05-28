import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingHumanApproval } from "./openclaw-capital-live-trading-human-approval.mjs";

const currentFile = fileURLToPath(import.meta.url);
const SCHEMA = "openclaw.capital.telegram-human-approval.v1";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
    approvalPath: "",
    operator: "telegram-human-reviewer",
    rollbackPlan:
      "Telegram manual rollback: keep allowLiveTrading/writeBrokerOrders false, stop CapitalHftService if needed, verify no broker command file was written.",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--operator") {
      options.operator = argv[index + 1] || options.operator;
      index += 1;
    } else if (arg === "--rollback-plan") {
      options.rollbackPlan = argv[index + 1] || options.rollbackPlan;
      index += 1;
    } else if (arg === "--approval") {
      options.approvalPath = argv[index + 1] || "";
      index += 1;
    }
  }
  return options;
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buttonId(action, token) {
  return `caplive:${action}:${sha256Text(token).slice(0, 16).toLowerCase()}`;
}

function buildTelegramMessage({ request }) {
  const accountCount = Array.isArray(request.accountAllowlist)
    ? request.accountAllowlist.length
    : 0;
  return [
    "群益真單人工核准請求",
    `狀態：${request.status}`,
    `帳號白名單：${accountCount}`,
    `approvalToken：${request.approvalToken}`,
    "安全：live/write/order=OFF",
    "注意：按鈕只寫入人工核准狀態，不會送出真單。",
  ].join("\n");
}

function buildButtons({ request }) {
  return [
    {
      id: "approve-human-review",
      label: "核准人工審查",
      action: "approve",
      callbackData: buttonId("approve", request.approvalToken),
      grantsLiveTrading: false,
      grantsBrokerWrite: false,
      sendsOrder: false,
    },
    {
      id: "deny-human-review",
      label: "拒絕真單核准",
      action: "deny",
      callbackData: buttonId("deny", request.approvalToken),
      grantsLiveTrading: false,
      grantsBrokerWrite: false,
      sendsOrder: false,
    },
    {
      id: "refresh-human-approval",
      label: "刷新核准狀態",
      action: "refresh",
      callbackData: buttonId("refresh", request.approvalToken),
      grantsLiveTrading: false,
      grantsBrokerWrite: false,
      sendsOrder: false,
    },
  ];
}

function quoteForPowerShell(value) {
  const raw = typeof value === "string" ? value : "";
  return `'${raw.replace(/'/g, "''")}'`;
}

function buildCommandPack({ request }) {
  const token = request.approvalToken || "<approvalToken>";
  const operator = "<人工核准者>";
  const rollbackPlan = "<回滾方式>";
  const base = "node scripts/openclaw-capital-live-trading-human-approval-receipt-onclick.mjs";
  return {
    requestDryRun: `${base} --action request --dry-run --json`,
    requestExecute: `${base} --action request --execute --json`,
    approveDryRunPreview: `${base} --action approve --dry-run --operator ${quoteForPowerShell(operator)} --rollback-plan ${quoteForPowerShell(rollbackPlan)} --token ${token} --json`,
    approveExecute: `${base} --action approve --execute --operator ${quoteForPowerShell(operator)} --rollback-plan ${quoteForPowerShell(rollbackPlan)} --token ${token} --write-approval --json`,
    denyExecute: `${base} --action deny --execute --operator ${quoteForPowerShell(operator)} --token ${token} --write-approval --json`,
  };
}

export async function buildCapitalTelegramHumanApproval(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const statePath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-telegram-human-approval-latest.json",
  );
  const request = await runCapitalLiveTradingHumanApproval({
    action: "request",
    approvalPath: options.approvalPath,
    writeState: options.writeState === true,
  });
  const buttons = buildButtons({ request });
  const blockers = [];
  if (request.status !== "pending_manual_human_approval") {
    blockers.push("human-approval:request-not-pending");
  }
  if (
    buttons.length !== 3 ||
    buttons.some(
      (button) => button.grantsLiveTrading || button.grantsBrokerWrite || button.sendsOrder,
    )
  ) {
    blockers.push("telegram-human-approval:unsafe-buttons");
  }
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? "telegram_human_approval_ready" : "blocked",
    mode: "telegram_human_approval_bridge",
    scope: {
      repoRoot,
      statePath,
      approvalRequestPath: request.reportPath,
    },
    telegramUi: {
      dryRunOnly: true,
      messageSent: false,
      message: buildTelegramMessage({ request }),
      buttons,
    },
    humanApprovalRequest: {
      status: request.status,
      approvalToken: request.approvalToken,
      accountAllowlistCount: request.accountAllowlist.length,
      approveExample: request.commands.approveExample,
      denyExample: request.commands.denyExample,
      commandPack: buildCommandPack({ request }),
    },
    callbackContract: {
      approveRequiresOperator: true,
      approveRequiresRollbackPlan: true,
      tokenRequired: true,
      writesHumanApprovalOnly: true,
      enablesLiveTrading: false,
      enablesBrokerWrite: false,
      sendsOrder: false,
    },
    safety: {
      telegramDryRunOnly: true,
      telegramMessageSent: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
    },
    blockers,
    nextSafeTask:
      "下一步接 Telegram human approval callback approve/deny 到 fixture/正式 approval file；仍不啟用 live/write/order。",
  };
  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(statePath, report);
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalTelegramHumanApproval({
    repoRoot: process.cwd(),
    approvalPath: options.approvalPath,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.check && report.status !== "telegram_human_approval_ready") {
    throw new Error(
      `CAPITAL_TELEGRAM_HUMAN_APPROVAL_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.telegramUi.message}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
