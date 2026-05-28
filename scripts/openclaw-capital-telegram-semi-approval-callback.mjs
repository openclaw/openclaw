import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";
import { buildCapitalTelegramSemiApprovalGate } from "./openclaw-capital-telegram-semi-approval-gate.mjs";

const SCHEMA = "openclaw.capital.telegram-semi-approval-callback.v1";

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

function isCapitalSemiCallbackToken(value) {
  return /^capital_semi_(approve|reject|refresh)_[a-f0-9]{16}$/iu.test(String(value || "").trim());
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    writeReviewChecklist: false,
    json: false,
    check: false,
    text: "模擬真單 台指近 多 1口",
    action: "approve",
    callbackData: "",
    approvalPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--write-review-checklist") {
      options.writeReviewChecklist = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--text") {
      options.text = argv[index + 1] || options.text;
      index += 1;
    } else if (arg === "--action") {
      options.action = argv[index + 1] || options.action;
      index += 1;
    } else if (arg === "--callback-data") {
      options.callbackData = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--approval-path") {
      options.approvalPath = argv[index + 1] || "";
      index += 1;
    }
  }
  return options;
}

function requestedButton({ gate, action, callbackData }) {
  const buttons = Array.isArray(gate.telegramUi?.buttons) ? gate.telegramUi.buttons : [];
  if (callbackData) {
    return buttons.find((button) => button.callbackData === callbackData) || null;
  }
  const normalized = String(action || "").toLowerCase();
  if (normalized === "approve") {
    return buttons.find((button) => button.action === "approve_paper_simulated") || null;
  }
  if (normalized === "reject") {
    return buttons.find((button) => button.action === "reject_paper_simulated") || null;
  }
  if (normalized === "refresh") {
    return buttons.find((button) => button.action === "refresh_fresh_matched_quote") || null;
  }
  return null;
}

function reviewChecklistPatch({ approval, button }) {
  const current = approval?.reviewChecklist || {};
  if (button?.action === "approve_paper_simulated") {
    return {
      ...current,
      telegramNotificationVerified: true,
      manualOperatorConfirmed: true,
      telegramSemiApprovalAction: "approve_paper_simulated",
    };
  }
  if (button?.action === "reject_paper_simulated") {
    return {
      ...current,
      telegramNotificationVerified: true,
      manualOperatorConfirmed: false,
      telegramSemiApprovalAction: "reject_paper_simulated",
    };
  }
  return {
    ...current,
    telegramSemiApprovalAction: "refresh_fresh_matched_quote",
  };
}

function nextApproval({ approval, patch, button }) {
  const action = button?.action || "unknown";
  return {
    ...approval,
    humanApproved: false,
    manualAccountReviewRequired: true,
    approvalStatus:
      action === "approve_paper_simulated"
        ? "telegram_callback_operator_confirmed_paper_only"
        : action === "reject_paper_simulated"
          ? "telegram_callback_rejected_paper_only"
          : approval?.approvalStatus || "template_pending_manual_review",
    reviewChecklist: patch,
    safety: {
      ...approval?.safety,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      sentOrder: false,
      manualEditRequired: true,
    },
    telegramSemiApprovalCallback: {
      action,
      updatedAt: new Date().toISOString(),
      grantsLiveTrading: false,
      sentOrder: false,
    },
  };
}

export async function buildCapitalTelegramSemiApprovalCallback(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const productionApprovalPath = path.join(
    repoRoot,
    "config",
    "capital-live-trading-approval.json",
  );
  const approvalPath = path.resolve(options.approvalPath || productionApprovalPath);
  const enforceReplayGuard = approvalPath === productionApprovalPath;
  const consumedCallbackPath = path.join(
    stateRoot,
    "openclaw-capital-telegram-semi-callback-consumed.json",
  );
  const gate = await buildCapitalTelegramSemiApprovalGate({
    repoRoot,
    text: options.text || "模擬真單 台指近 多 1口",
  });
  const approval = await readJsonIfExists(approvalPath);
  const consumed = (await readJsonIfExists(consumedCallbackPath)) || {};
  const button = requestedButton({
    gate,
    action: options.action || "approve",
    callbackData: options.callbackData || "",
  });
  const promotion = (await runCapitalLiveTradingPromotionGate({ writeState: false })).report;
  const patch = reviewChecklistPatch({ approval, button });
  const updatedApproval = nextApproval({ approval, patch, button });
  const blockers = [];
  if (!button) {
    blockers.push("telegram:semi-callback-not-recognized");
  }
  if (
    enforceReplayGuard &&
    (options.action === "approve" || options.action === "reject") &&
    options.writeReviewChecklist === true
  ) {
    if (!isCapitalSemiCallbackToken(options.callbackData || "")) {
      blockers.push("telegram:semi-callback-token-required");
    } else if (consumed[options.callbackData]) {
      blockers.push("telegram:semi-callback-token-replayed");
    }
  }
  if (button?.grantsLiveTrading !== false) {
    blockers.push("telegram:semi-callback-live-grant-forbidden");
  }
  if (promotion.status !== "blocked") {
    blockers.push("live:promotion-state-not-blocked");
  }
  if (updatedApproval.humanApproved !== false) {
    blockers.push("approval:human-approved-must-remain-false");
  }
  if (
    updatedApproval.safety?.allowLiveTrading !== false ||
    updatedApproval.safety?.writeBrokerOrders !== false
  ) {
    blockers.push("approval:live-write-must-remain-false");
  }
  if (updatedApproval.safety?.sentOrder !== false) {
    blockers.push("approval:sent-order-must-remain-false");
  }

  const canWrite =
    blockers.length === 0 &&
    options.writeReviewChecklist === true &&
    button?.action !== "refresh_fresh_matched_quote";
  if (canWrite) {
    await writeJsonWithSha(approvalPath, updatedApproval);
    if (enforceReplayGuard && isCapitalSemiCallbackToken(options.callbackData || "")) {
      const updatedConsumed = {
        ...consumed,
        [options.callbackData]: {
          consumedAt: new Date().toISOString(),
          action: button?.action || "unknown",
          approvalPath,
        },
      };
      await writeJsonWithSha(consumedCallbackPath, updatedConsumed);
    }
  }

  const status =
    blockers.length > 0
      ? "blocked"
      : canWrite
        ? "callback_review_checklist_written"
        : "callback_review_checklist_ready";
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status,
    mode: "telegram_semi_callback_review_checklist_only",
    scope: {
      repoRoot,
      approvalPath,
      statePath: path.join(
        stateRoot,
        "openclaw-capital-telegram-semi-approval-callback-latest.json",
      ),
      consumedCallbackPath,
    },
    callback: {
      requestedAction: options.action || "approve",
      callbackData: options.callbackData || button?.callbackData || "",
      matched: Boolean(button),
      button: button
        ? {
            id: button.id,
            action: button.action,
            label: button.label,
            grantsLiveTrading: button.grantsLiveTrading === true,
          }
        : null,
    },
    reviewChecklistPatch: patch,
    approvalWrite: {
      requested: options.writeReviewChecklist === true,
      applied: canWrite,
      writesProductionApprovalFile:
        approvalPath === path.join(repoRoot, "config", "capital-live-trading-approval.json"),
      keepsHumanApprovedFalse: updatedApproval.humanApproved === false,
      keepsLiveTradingDisabled: updatedApproval.safety?.allowLiveTrading === false,
      keepsBrokerWriteDisabled: updatedApproval.safety?.writeBrokerOrders === false,
    },
    promotionGate: {
      status: promotion.status,
      blockerCode: promotion.blockerCode,
      blockers: promotion.blockers || [],
      sentOrder: promotion.sentOrder ?? false,
    },
    safety: {
      telegramCallbackOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
      doesNotSetHumanApproved: true,
      semiApprovalDoesNotUnlockLive: true,
    },
    blockers,
    replyText:
      status === "blocked"
        ? `[OpenClaw SEMI callback] 封鎖｜原因=${blockers.join(",")}｜真單=封鎖｜sentOrder=false`
        : `[OpenClaw SEMI callback] 已處理 ${button.action}｜reviewChecklist=${canWrite ? "已寫入" : "待寫入"}｜真單=封鎖｜sentOrder=false`,
    nextSafeTask:
      "下一步完成 PreTradeRiskGate before every broker send path；仍不得啟用 live API、broker write 或真單。",
  };

  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(report.scope.statePath, report);
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalTelegramSemiApprovalCallback({
    repoRoot: process.cwd(),
    text: options.text,
    action: options.action,
    callbackData: options.callbackData,
    approvalPath: options.approvalPath,
    writeReviewChecklist: options.writeReviewChecklist,
    writeState: options.writeState,
    check: options.check,
  });
  if (options.check && report.status === "blocked") {
    throw new Error(
      `CAPITAL_TELEGRAM_SEMI_APPROVAL_CALLBACK_BLOCKED blockers=${report.blockers.join(",")}`,
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
