import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingHumanApproval } from "./openclaw-capital-live-trading-human-approval.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";
import { buildCapitalTelegramHumanApproval } from "./openclaw-capital-telegram-human-approval.mjs";

const currentFile = fileURLToPath(import.meta.url);
const SCHEMA = "openclaw.capital.telegram-human-approval-callback.v1";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function quoteForPowerShell(value) {
  const raw = typeof value === "string" ? value : "";
  return `'${raw.replace(/'/g, "''")}'`;
}

function buildCommandPack({ action, token, operator, rollbackPlan }) {
  const tokenArg = token || "<approvalToken>";
  const operatorArg = operator || "<人工核准者>";
  const rollbackArg = rollbackPlan || "<回滾方式>";
  const base = "node scripts/openclaw-capital-live-trading-human-approval-receipt-onclick.mjs";
  return {
    currentAction: `${base} --action ${action} --execute --operator ${quoteForPowerShell(operatorArg)} --rollback-plan ${quoteForPowerShell(rollbackArg)} --token ${tokenArg} --write-approval --json`,
    approveExecute: `${base} --action approve --execute --operator ${quoteForPowerShell(operatorArg)} --rollback-plan ${quoteForPowerShell(rollbackArg)} --token ${tokenArg} --write-approval --json`,
    denyExecute: `${base} --action deny --execute --operator ${quoteForPowerShell(operatorArg)} --token ${tokenArg} --write-approval --json`,
    requestDryRun: `${base} --action request --dry-run --json`,
  };
}

function buildTelegramReply({ callbackExecutionSummary, promotionGate, blockers }) {
  const blockerText =
    Array.isArray(promotionGate?.blockers) && promotionGate.blockers.length > 0
      ? promotionGate.blockers.join(",")
      : "none";
  const textSummaryZhTw = [
    "[OpenClaw 人工審核回執]",
    `動作=${callbackExecutionSummary.requestedAction}`,
    `寫入狀態=${callbackExecutionSummary.manualApprovalStatus}`,
    `promotion=${callbackExecutionSummary.promotionStatus}/${callbackExecutionSummary.promotionBlockerCode || "none"}`,
    `promotionBlockers=${blockerText}`,
    `safetyLock=${callbackExecutionSummary.liveWriteOrderLocked ? "ON" : "OFF"}`,
    "live/write/order=OFF",
    `callbackBlockers=${Array.isArray(blockers) && blockers.length > 0 ? blockers.join(",") : "none"}`,
  ].join("；");
  return {
    textSummaryZhTw,
    includesActionResult: true,
    includesPromotionResult: true,
    includesSafetyLock: /live\/write\/order=OFF/u.test(textSummaryZhTw),
  };
}

function parseArgs(argv) {
  const options = {
    action: "approve",
    operator: "telegram-human-reviewer",
    rollbackPlan:
      "Telegram manual rollback: keep allowLiveTrading/writeBrokerOrders false, stop CapitalHftService if needed, verify no broker command file was written.",
    approvalPath: "",
    writeState: false,
    writeApproval: false,
    json: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--action") {
      options.action = argv[index + 1] || options.action;
      index += 1;
    } else if (arg === "--operator") {
      options.operator = argv[index + 1] || options.operator;
      index += 1;
    } else if (arg === "--rollback-plan") {
      options.rollbackPlan = argv[index + 1] || options.rollbackPlan;
      index += 1;
    } else if (arg === "--approval") {
      options.approvalPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--write-approval") {
      options.writeApproval = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
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

export async function buildCapitalTelegramHumanApprovalCallback(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
  const approvalPath = path.resolve(options.approvalPath || sourceApprovalPath);
  const statePath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-telegram-human-approval-callback-latest.json",
  );
  const telegramApproval = await buildCapitalTelegramHumanApproval({
    repoRoot,
    approvalPath,
    writeState: false,
  });
  const token = telegramApproval.humanApprovalRequest.approvalToken;
  const action = options.action || "approve";
  const approvalResult = await runCapitalLiveTradingHumanApproval({
    action,
    approvalPath,
    operator: options.operator || "telegram-human-reviewer",
    rollbackPlan: options.rollbackPlan || "",
    token,
    writeApproval: options.writeApproval === true,
    writeState: false,
  });
  const promotion = (
    await runCapitalLiveTradingPromotionGate({
      approvalPath,
      writeState: false,
    })
  ).report;
  const blockers = [];
  if (approvalResult.status === "blocked") {
    blockers.push(...approvalResult.blockers);
  }
  if (approvalResult.safety?.sentOrder !== false || promotion.sentOrder !== false) {
    blockers.push("telegram-human-approval-callback:sent-order-forbidden");
  }
  if (
    approvalResult.safety?.liveTradingEnabled !== false ||
    approvalResult.safety?.writeBrokerOrders !== false
  ) {
    blockers.push("telegram-human-approval-callback:live-write-enabled-forbidden");
  }
  const callbackCommandPack = buildCommandPack({
    action,
    token,
    operator: options.operator || "telegram-human-reviewer",
    rollbackPlan: options.rollbackPlan || "",
  });
  const callbackExecutionSummary = {
    requestedAction: action,
    approvalStatus: approvalResult.status,
    approvalApplied: approvalResult.approvalWrite?.applied === true,
    manualApprovalStatus:
      approvalResult.approvalWrite?.applied === true
        ? action === "approve"
          ? "manual_approved_written"
          : action === "deny"
            ? "manual_denied_written"
            : "manual_request_only"
        : "manual_not_written",
    promotionStatus: promotion.status,
    promotionBlockerCode: promotion.blockerCode,
    promotionBlockerCount: Array.isArray(promotion.blockers) ? promotion.blockers.length : 0,
    liveWriteOrderLocked:
      approvalResult.safety?.liveTradingEnabled === false &&
      approvalResult.safety?.writeBrokerOrders === false &&
      approvalResult.safety?.sentOrder === false &&
      promotion.sentOrder === false,
  };
  const telegramReply = buildTelegramReply({
    callbackExecutionSummary,
    promotionGate: promotion,
    blockers,
  });
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? "telegram_human_approval_callback_ready" : "blocked",
    mode: "telegram_human_approval_callback",
    scope: {
      repoRoot,
      approvalPath,
      statePath,
      productionApprovalWrite: approvalPath === sourceApprovalPath,
    },
    callback: {
      action,
      tokenSha256: sha256Text(token),
      operator: options.operator || "telegram-human-reviewer",
      commandPack: callbackCommandPack,
    },
    callbackExecutionSummary,
    telegramReply,
    approvalResult: {
      status: approvalResult.status,
      applied: approvalResult.approvalWrite?.applied === true,
      humanApproved: approvalResult.approvalWrite?.humanApproved === true,
      killSwitch: approvalResult.approvalWrite?.killSwitch === true,
      rollbackPlanFilled: approvalResult.approvalWrite?.rollbackPlanFilled === true,
      writesProductionApprovalFile:
        approvalResult.approvalWrite?.writesProductionApprovalFile === true,
    },
    promotionGate: {
      status: promotion.status,
      blockerCode: promotion.blockerCode,
      blockers: promotion.blockers || [],
      sentOrder: promotion.sentOrder === true,
    },
    safety: {
      callbackOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
      doesNotEnableLiveTrading: true,
      doesNotSendOrder: true,
    },
    blockers,
    nextSafeTask:
      "Telegram human approval callback 已可寫入人工核准狀態；下一步處理 latency/gap instrumentation 與 simulation risk gate，仍不啟用 live/write/order。",
  };
  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(statePath, report);
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check && !options.approvalPath) {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-capital-telegram-human-approval-"),
    );
    const fixturePath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
    await fs.copyFile(
      path.join(process.cwd(), "config", "capital-live-trading-approval.json"),
      fixturePath,
    );
    options.approvalPath = fixturePath;
    options.writeApproval = true;
  }
  const report = await buildCapitalTelegramHumanApprovalCallback({
    repoRoot: process.cwd(),
    action: options.action,
    operator: options.operator,
    rollbackPlan: options.rollbackPlan,
    approvalPath: options.approvalPath,
    writeApproval: options.writeApproval,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.check && report.status !== "telegram_human_approval_callback_ready") {
    throw new Error(
      `CAPITAL_TELEGRAM_HUMAN_APPROVAL_CALLBACK_BLOCKED blockers=${report.blockers.join(",")}`,
    );
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.telegramReply.textSummaryZhTw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
