import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalLiveTradingApprovalSummary } from "./openclaw-capital-live-trading-approval-summary.mjs";
import { runCapitalLiveTradingHumanApproval } from "./openclaw-capital-live-trading-human-approval.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const stateDir = path.join(repoRoot, "reports", "hermes-agent", "state");

const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_APPROVAL_REPORT_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-human-approval-request-latest.json",
);
const DEFAULT_APPROVAL_MARKDOWN_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-human-approval-request-latest.md",
);
const DEFAULT_SUMMARY_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-approval-summary-latest.json",
);
const DEFAULT_SUMMARY_MARKDOWN_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-approval-summary-latest.md",
);
const DEFAULT_TELEGRAM_REPORT_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-human-approval-telegram-publish-latest.json",
);
const DEFAULT_RECEIPT_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-human-approval-receipt-onclick-latest.json",
);
const DEFAULT_RECEIPT_MARKDOWN_PATH = path.join(
  stateDir,
  "openclaw-capital-live-trading-human-approval-receipt-onclick-latest.md",
);

function parseArgs(argv) {
  const options = {
    action: "request",
    approvalPath: DEFAULT_APPROVAL_PATH,
    approvalOutput: DEFAULT_APPROVAL_REPORT_PATH,
    approvalMarkdown: DEFAULT_APPROVAL_MARKDOWN_PATH,
    summaryOutput: DEFAULT_SUMMARY_PATH,
    summaryMarkdown: DEFAULT_SUMMARY_MARKDOWN_PATH,
    telegramReport: DEFAULT_TELEGRAM_REPORT_PATH,
    output: DEFAULT_RECEIPT_PATH,
    markdown: DEFAULT_RECEIPT_MARKDOWN_PATH,
    operator: "",
    rollbackPlan: "",
    token: "",
    writeApproval: false,
    dryRun: true,
    json: false,
    check: false,
    telegramTarget: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--action") {
      options.action = argv[index + 1] || options.action;
      index += 1;
    } else if (arg === "--approval") {
      options.approvalPath = argv[index + 1] || options.approvalPath;
      index += 1;
    } else if (arg === "--approval-output") {
      options.approvalOutput = argv[index + 1] || options.approvalOutput;
      index += 1;
    } else if (arg === "--approval-markdown") {
      options.approvalMarkdown = argv[index + 1] || options.approvalMarkdown;
      index += 1;
    } else if (arg === "--summary-output") {
      options.summaryOutput = argv[index + 1] || options.summaryOutput;
      index += 1;
    } else if (arg === "--summary-markdown") {
      options.summaryMarkdown = argv[index + 1] || options.summaryMarkdown;
      index += 1;
    } else if (arg === "--telegram-report") {
      options.telegramReport = argv[index + 1] || options.telegramReport;
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
    } else if (arg === "--telegram-target") {
      options.telegramTarget = argv[index + 1] || options.telegramTarget;
      index += 1;
    } else if (arg === "--write-approval") {
      options.writeApproval = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--execute") {
      options.dryRun = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    }
  }

  return options;
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

async function runTelegramPublish(options) {
  const args = [
    "scripts/openclaw-controlled-task-runner-telegram-publish.mjs",
    options.dryRun ? "--dry-run" : "--execute",
    "--summary",
    options.summaryPath,
    "--report",
    options.reportPath,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      shell: false,
      env: {
        ...process.env,
        ...(options.telegramTarget
          ? { OPENCLAW_TELEGRAM_STATUS_TARGET: options.telegramTarget }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
    child.once("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: stdout.join(""),
        stderr: `${stderr.join("")}\n${error.message}`.trim(),
      });
    });
  });
}

function buildReceiptMarkdown(report) {
  const checklist = Object.entries(report.checklist || {})
    .map(([key, value]) => `- ${key}: ${value === true ? "true" : "false"}`)
    .join("\n");
  const commandPack = report?.approval?.commandPack || {};
  return [
    "# Capital Live Trading Human Approval One-Click Receipt",
    "",
    `- status: ${report.status}`,
    `- mode: ${report.mode}`,
    `- approvalStatus: ${report.approval.status}`,
    `- summaryStatus: ${report.summary.status}`,
    `- telegramStatus: ${report.telegram.status}`,
    `- telegramDryRun: ${report.telegram.dryRun}`,
    `- telegramTarget: ${report.telegram.target || "<none>"}`,
    `- telegramMessage: ${report.telegram.message || "<empty>"}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    "",
    "## Manual Checklist",
    checklist || "- <empty>",
    "",
    "## One-Click Commands",
    "```powershell",
    commandPack.requestDryRun || "N/A",
    commandPack.approveExecute || "N/A",
    commandPack.denyExecute || "N/A",
    "```",
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

function normalizeTelegramStatus(publishReport, publishExitCode) {
  if (publishExitCode !== 0) {
    return "publish_command_failed";
  }
  if (publishReport?.status === "dry_run_ok" || publishReport?.status === "publish_ok") {
    return publishReport.status;
  }
  return publishReport?.status || "publish_unknown";
}

function quoteForPowerShell(value) {
  const raw = typeof value === "string" ? value : "";
  return `'${raw.replace(/'/g, "''")}'`;
}

function buildCommandPack({ dryRun, action, token, operator, rollbackPlan }) {
  const tokenArg = token || "<approvalToken>";
  const operatorArg = operator || "<人工核准者>";
  const rollbackArg = rollbackPlan || "<回滾方式>";
  const base = "node scripts/openclaw-capital-live-trading-human-approval-receipt-onclick.mjs";
  return {
    requestDryRun: `${base} --action request --dry-run --json`,
    requestExecute: `${base} --action request --execute --json`,
    approveDryRunPreview: `${base} --action approve --dry-run --operator ${quoteForPowerShell(operatorArg)} --rollback-plan ${quoteForPowerShell(rollbackArg)} --token ${tokenArg} --json`,
    approveExecute: `${base} --action approve --execute --operator ${quoteForPowerShell(operatorArg)} --rollback-plan ${quoteForPowerShell(rollbackArg)} --token ${tokenArg} --write-approval --json`,
    denyExecute: `${base} --action deny --execute --operator ${quoteForPowerShell(operatorArg)} --token ${tokenArg} --write-approval --json`,
    currentAction: `${base} --action ${action} ${dryRun ? "--dry-run" : "--execute"} --json`,
  };
}

export async function runCapitalLiveTradingHumanApprovalReceiptOnclick(options = {}) {
  const action = options.action || "request";
  const dryRun = options.dryRun !== false;
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const approvalOutputPath = path.resolve(options.approvalOutput || DEFAULT_APPROVAL_REPORT_PATH);
  const approvalMarkdownPath = path.resolve(
    options.approvalMarkdown || DEFAULT_APPROVAL_MARKDOWN_PATH,
  );
  const summaryOutputPath = path.resolve(options.summaryOutput || DEFAULT_SUMMARY_PATH);
  const summaryMarkdownPath = path.resolve(
    options.summaryMarkdown || DEFAULT_SUMMARY_MARKDOWN_PATH,
  );
  const telegramReportPath = path.resolve(options.telegramReport || DEFAULT_TELEGRAM_REPORT_PATH);
  const receiptPath = path.resolve(options.output || DEFAULT_RECEIPT_PATH);
  const receiptMarkdownPath = path.resolve(options.markdown || DEFAULT_RECEIPT_MARKDOWN_PATH);

  const approvalReport = await runCapitalLiveTradingHumanApproval({
    action,
    approvalPath,
    output: approvalOutputPath,
    markdown: approvalMarkdownPath,
    operator: options.operator || "",
    rollbackPlan: options.rollbackPlan || "",
    token: options.token || "",
    writeState: true,
    writeApproval: options.writeApproval === true,
  });

  const summaryReport = await buildCapitalLiveTradingApprovalSummary({
    approvalPath,
    writeGateState: true,
  });
  await writeText(summaryOutputPath, `${JSON.stringify(summaryReport, null, 2)}\n`);
  await writeText(
    summaryMarkdownPath,
    [
      "# Capital Live Trading Approval Summary",
      "",
      `- status: ${summaryReport.status}`,
      `- telegram: ${summaryReport.telegram_summary_oneline_zh_tw}`,
      "",
    ].join("\n"),
  );

  const publishCommandResult = await runTelegramPublish({
    dryRun,
    summaryPath: summaryOutputPath,
    reportPath: telegramReportPath,
    telegramTarget: options.telegramTarget || "",
  });

  let publishReport = null;
  try {
    publishReport = JSON.parse(
      (await fs.readFile(telegramReportPath, "utf8")).replace(/^\uFEFF/u, ""),
    );
  } catch {
    publishReport = null;
  }

  const telegramStatus = normalizeTelegramStatus(publishReport, publishCommandResult.exitCode);
  const blockers = [];
  if (approvalReport.status === "blocked") {
    blockers.push("approval:human-checklist-blocked");
  }
  if (!(telegramStatus === "dry_run_ok" || telegramStatus === "publish_ok")) {
    blockers.push("telegram:publish-not-ready");
  }

  const status =
    blockers.length > 0 ? "blocked" : dryRun ? "dry_run_receipt_ready" : "publish_receipt_ready";

  const receipt = {
    schema: "openclaw.capital.live-trading-human-approval-receipt-onclick.v1",
    generatedAt: new Date().toISOString(),
    status,
    mode: dryRun ? "dry_run" : "execute",
    approval: {
      status: approvalReport.status,
      action,
      approvalToken: approvalReport.approvalToken,
      approvalOutputPath,
      approvalMarkdownPath,
      approvalWriteApplied: approvalReport.approvalWrite?.applied === true,
      commandPack: buildCommandPack({
        dryRun,
        action,
        token: approvalReport.approvalToken,
        operator: options.operator || "",
        rollbackPlan: options.rollbackPlan || "",
      }),
    },
    checklist: approvalReport.checklist,
    summary: {
      status: summaryReport.status,
      summaryOutputPath,
      summaryMarkdownPath,
      telegramSummary: summaryReport.telegram_summary_oneline_zh_tw,
    },
    telegram: {
      status: telegramStatus,
      dryRun,
      target: publishReport?.target || "",
      targetSource: publishReport?.targetSource || "",
      message: publishReport?.message || "",
      reportPath: telegramReportPath,
      commandExitCode: publishCommandResult.exitCode,
      commandErrorCode: publishReport?.commandErrorCode || "",
    },
    blockers,
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      doesNotSendOrder: true,
      doesNotEnableBrokerWrite: true,
    },
    nextSafeTask:
      status === "blocked"
        ? "補齊人工審核欄位或 Telegram target，重跑 capital:live-trading:human-approval:receipt:check。"
        : "人工確認回執後，維持 live/write/order=OFF，繼續手動審核流程。",
  };

  await writeText(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeText(receiptMarkdownPath, buildReceiptMarkdown(receipt));

  return receipt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalLiveTradingHumanApprovalReceiptOnclick(options);
  if (options.check && report.status === "blocked") {
    throw new Error(
      `CAPITAL_LIVE_TRADING_HUMAN_APPROVAL_RECEIPT_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `status=${report.status}`,
      `mode=${report.mode}`,
      `telegramStatus=${report.telegram.status}`,
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
