import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";
import { buildCapitalTelegramSimulatedLiveOrder } from "./openclaw-capital-telegram-simulated-live-order.mjs";

const SCHEMA = "openclaw.capital.telegram-semi-approval-gate.v1";
const SAFE_CHECK_STATUSES = new Set([
  "semi_approval_pending_live_blocked",
  "semi_approval_ready_for_manual_review",
]);

const isTrue = (value) => value === true;
const isFalse = (value) => value === false;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
    text: "模擬真單 台指近 多 1口",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--text") {
      options.text = argv[index + 1] || options.text;
      index += 1;
    }
  }
  return options;
}

function buildCallbackId({ action, parsed, approvalNonce }) {
  const seed = [
    "capital",
    "semi",
    action,
    parsed?.symbol || "",
    parsed?.side || "",
    parsed?.quantity || "",
    approvalNonce,
  ].join(":");
  return `capital_semi_${action}_${sha256Text(seed).slice(0, 16).toLowerCase()}`;
}

function buildButtons({ parsed, approvalNonce }) {
  return [
    {
      id: "approve-paper-simulated",
      label: "確認模擬真單",
      action: "approve_paper_simulated",
      callbackData: buildCallbackId({ action: "approve", parsed, approvalNonce }),
      effect: "records_operator_confirmation_only",
      grantsLiveTrading: false,
    },
    {
      id: "reject-paper-simulated",
      label: "拒絕",
      action: "reject_paper_simulated",
      callbackData: buildCallbackId({ action: "reject", parsed, approvalNonce }),
      effect: "keeps_live_blocked",
      grantsLiveTrading: false,
    },
    {
      id: "refresh-quote",
      label: "刷新報價",
      action: "refresh_fresh_matched_quote",
      callbackData: buildCallbackId({ action: "refresh", parsed, approvalNonce }),
      effect: "read_only_quote_refresh",
      grantsLiveTrading: false,
    },
  ];
}

function approvalState(approval) {
  const checklist = approval?.reviewChecklist || {};
  return {
    approvalFilePresent: approval != null,
    approvalStatus: approval?.approvalStatus || "missing",
    humanApproved: approval?.humanApproved === true,
    manualOperatorConfirmed: checklist.manualOperatorConfirmed === true,
    telegramNotificationVerified: checklist.telegramNotificationVerified === true,
    killSwitch: approval?.killSwitch === true,
    hasRollbackPlan:
      typeof approval?.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0,
    allowLiveTrading: approval?.safety?.allowLiveTrading === true,
    writeBrokerOrders: approval?.safety?.writeBrokerOrders === true,
  };
}

export async function buildCapitalTelegramSemiApprovalGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const approvalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
  const text = options.text || "模擬真單 台指近 多 1口";
  const [telegramSimulatedLive, promotionResult, approval] = await Promise.all([
    buildCapitalTelegramSimulatedLiveOrder({ repoRoot, text }),
    runCapitalLiveTradingPromotionGate({ writeState: false }),
    readJsonIfExists(approvalPath),
  ]);
  const promotion = promotionResult.report;
  const parsed = telegramSimulatedLive.input?.parsed || {};
  const approvalNonce = sha256Text(
    `${parsed.rawText || text}:${approval?.approvalStatus || ""}`,
  ).slice(0, 12);
  const buttons = buildButtons({ parsed, approvalNonce });
  const state = approvalState(approval);
  const blockers = [];
  if (telegramSimulatedLive.status !== "telegram_simulated_live_ready") {
    blockers.push("telegram:simulated-live-not-ready");
  }
  if (buttons.length < 3 || buttons.some((button) => !isFalse(button.grantsLiveTrading))) {
    blockers.push("telegram:semi-buttons-invalid");
  }
  if (!isTrue(state.manualOperatorConfirmed)) {
    blockers.push("telegram:semi-human-confirmation-pending");
  }
  if (promotion.status !== "blocked") {
    blockers.push("live:promotion-state-not-blocked");
  }
  if (
    !isFalse(promotion.sentOrder) ||
    !isFalse(promotion.liveTradingEnabled) ||
    !isFalse(promotion.writeTradingEnabled)
  ) {
    blockers.push("live:promotion-safety-not-locked");
  }
  if (isTrue(state.allowLiveTrading) || isTrue(state.writeBrokerOrders)) {
    blockers.push("approval-file-live-write-enabled");
  }
  const status =
    blockers.length === 0
      ? "semi_approval_ready_for_manual_review"
      : "semi_approval_pending_live_blocked";
  const route = [
    {
      id: "telegram:simulated-live-ready",
      status: telegramSimulatedLive.status === "telegram_simulated_live_ready" ? "pass" : "fail",
      evidence: {
        status: telegramSimulatedLive.status,
        routingDecision: telegramSimulatedLive.simulatedLive?.routingDecision || "",
        sentOrder: isTrue(telegramSimulatedLive.safety?.sentOrder),
      },
    },
    {
      id: "telegram:semi-buttons-rendered",
      status:
        buttons.length >= 3 && buttons.every((button) => isFalse(button.grantsLiveTrading))
          ? "pass"
          : "fail",
      evidence: {
        buttonCount: buttons.length,
        labels: buttons.map((button) => button.label),
        grantsLiveTrading: buttons.some((button) => isTrue(button.grantsLiveTrading)),
      },
    },
    {
      id: "telegram:operator-confirmation-state",
      status: isTrue(state.manualOperatorConfirmed) ? "pass" : "pending",
      evidence: {
        humanApproved: state.humanApproved,
        manualOperatorConfirmed: state.manualOperatorConfirmed,
        telegramNotificationVerified: state.telegramNotificationVerified,
      },
    },
    {
      id: "openclaw:live-promotion-remains-blocked",
      status: promotion.status === "blocked" && isFalse(promotion.sentOrder) ? "pass" : "fail",
      evidence: {
        status: promotion.status,
        blockerCode: promotion.blockerCode || "",
        blockers: promotion.blockers || [],
        sentOrder: isTrue(promotion.sentOrder),
      },
    },
  ];
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "telegram_semi_approval_dry_run_gate",
    scope: {
      repoRoot,
      approvalPath,
      statePath: path.join(stateRoot, "openclaw-capital-telegram-semi-approval-gate-latest.json"),
    },
    input: {
      channel: "telegram",
      text,
      parsed,
    },
    approvalState: state,
    telegramUi: {
      dryRunOnly: true,
      messageSent: false,
      buttons,
      replyPreview: `[OpenClaw SEMI] 等待人工確認｜商品=${parsed.symbol || ""}｜方向=${parsed.side || ""}｜數量=${parsed.quantity || 0}｜真單=封鎖｜sentOrder=false`,
    },
    promotionGate: {
      schema: promotion.schema,
      status: promotion.status,
      blockerCode: promotion.blockerCode,
      readyForManualReview: isTrue(promotion.readyForManualReview),
      blockers: promotion.blockers || [],
    },
    route,
    safety: {
      telegramDryRunOnly: true,
      telegramMessageSent: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
      doesNotSetHumanApproved: true,
      doesNotWriteBrokerCommand: true,
      semiApprovalDoesNotUnlockLive: true,
    },
    blockers,
    replyText:
      status === "semi_approval_ready_for_manual_review"
        ? `[OpenClaw SEMI] 已可進入人工審查｜商品=${parsed.symbol || ""}｜真單=仍封鎖｜sentOrder=false`
        : `[OpenClaw SEMI] 等待 Telegram 人工確認｜真單=封鎖｜sentOrder=false｜blockers=${blockers.join(",")}`,
    nextSafeTask:
      "下一步接 Telegram callback handler 的 approve/reject 狀態寫入 reviewChecklist；仍不得設定 humanApproved=true 或啟用真單。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const report = await buildCapitalTelegramSemiApprovalGate({ repoRoot, text: options.text });
  const outputPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-telegram-semi-approval-gate-latest.json",
  );
  if (options.writeState || options.check) {
    await writeJsonWithSha(outputPath, report);
  }
  if (options.check && !SAFE_CHECK_STATUSES.has(report.status)) {
    throw new Error(
      `CAPITAL_TELEGRAM_SEMI_APPROVAL_GATE_UNEXPECTED_STATUS status=${report.status}`,
    );
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.replyText}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
