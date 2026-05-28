import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalLiveExecutorArmProfile } from "./openclaw-capital-live-executor-arm-profile.mjs";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";
import { buildCapitalLiveTradingApprovalSummary } from "./openclaw-capital-live-trading-approval-summary.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-operation-capability-latest.json",
);
const DEFAULT_MD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-operation-capability-latest.md",
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

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function operationStep(id, status, command, evidence = {}) {
  return {
    id,
    status,
    command,
    evidence,
  };
}

function buildMarkdown(report) {
  return [
    "# Capital Live Operation Capability",
    "",
    `- status: ${report.status}`,
    `- brokerWriteAllowed: ${report.safety.brokerWriteAllowed}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- brokerApi: ${report.liveOrderShape.brokerApi}`,
    `- orderSymbol: ${report.liveOrderShape.symbol}`,
    `- blockerCode: ${report.blockerCode}`,
    `- nextSafeTask: ${report.nextSafeTask}`,
    "",
    "## Operation Path",
    ...report.operationPath.map((step) => `- ${step.id}: ${step.status} :: \`${step.command}\``),
    "",
  ].join("\n");
}

export async function buildCapitalLiveOperationCapability(options = {}) {
  const dryRun = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot });
  const approvalSummary = await buildCapitalLiveTradingApprovalSummary({
    syncAccountAllowlist: false,
    writeGateState: false,
  });
  const { report: promotionGate } = await runCapitalLiveTradingPromotionGate({
    writeState: false,
  });
  const armProfile = await buildCapitalLiveExecutorArmProfile({ repoRoot });

  const operationPath = [
    operationStep(
      "simulated-live-intent",
      "ready_paper_only",
      "pnpm capital-hft:capital:simulated-live:check",
    ),
    operationStep(
      "live-order-shape-dry-run",
      dryRun.status === "live_order_dry_run_pretrade_blocked" ? "ready_blocked" : "incomplete",
      "pnpm capital-hft:capital:live-order-dry-run:check",
      {
        brokerApi: dryRun.liveOrderDraft?.brokerApi || "",
        brokerStruct: dryRun.liveOrderDraft?.brokerStruct || "",
        symbol: dryRun.liveOrderDraft?.commandPayload?.stockNo || "",
        allowedToSend: dryRun.preTradeRiskGate?.allowedToSend === true,
        sentOrder: dryRun.safety?.sentOrder === true,
      },
    ),
    operationStep(
      "telegram-semi-approval",
      "ready_blocked",
      "pnpm capital:telegram:semi-approval:check",
    ),
    operationStep(
      "telegram-human-approval",
      "ready_blocked",
      "pnpm capital:telegram:human-approval:check",
    ),
    operationStep(
      "manual-human-approval-unit",
      approvalSummary.status,
      "pnpm capital-hft:live-trading:human-approval:check",
      approvalSummary.approval,
    ),
    operationStep(
      "live-executor-arm-profile",
      armProfile.status,
      "pnpm capital:trade:live-executor-profile:check",
      {
        armed: armProfile.armed === true,
        allowExecutorWrite: armProfile.allowBrokerWriteWhenAllGatesPass === true,
        expiresAt: armProfile.expiresAt,
        profilePath: armProfile.paths.profilePath,
        templatePath: armProfile.paths.templatePath,
        noLiveOrderSent: armProfile.safety.noLiveOrderSent === true,
      },
    ),
    operationStep(
      "live-promotion-gate",
      promotionGate.status,
      "pnpm capital-hft:live-trading:promotion:check",
      {
        blockerCode: promotionGate.blockerCode,
        readyForManualReview: promotionGate.readyForManualReview === true,
        blockers: promotionGate.blockers || [],
      },
    ),
  ];

  const liveOperationPathBuilt =
    dryRun.liveOrderDraft?.brokerApi &&
    dryRun.preTradeRiskGate?.attachedBeforeBrokerSend === true &&
    dryRun.preTradeRiskGate?.evaluated === true &&
    Array.isArray(operationPath) &&
    operationPath.length >= 7 &&
    armProfile.status !== "blocked_invalid";
  const blockers = [
    ...(Array.isArray(dryRun.preTradeRiskGate?.blockers) ? dryRun.preTradeRiskGate.blockers : []),
    ...(Array.isArray(promotionGate.blockers) ? promotionGate.blockers : []),
  ];
  const uniqueBlockers = [...new Set(blockers.filter(Boolean))];

  return {
    schema: "openclaw.capital.live-operation-capability.v1",
    generatedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    provider: "capital",
    status: liveOperationPathBuilt
      ? "capability_ready_live_executor_gated"
      : "capability_incomplete",
    mode: "controlled_live_capability_manifest",
    directOperationCapabilityBuilt: liveOperationPathBuilt,
    blockerCode: "LIVE_EXECUTOR_GATED_UNTIL_ALL_PRETRADE_GATES_PASS",
    requestedCapabilities: ["live_api", "send_order", "external_write"],
    currentBlockedCapabilities: ["live_api", "send_order", "external_write"],
    deniedCapabilities: ["direct_conversation_agent_broker_write"],
    authorityModel: {
      liveExecutorSupported: true,
      brokerWriteAuthorityTarget: "openclaw_managed_local_broker_executor",
      credentialOwner: "local_broker_executor",
      conversationAgentsHoldCredentials: false,
      conversationAgentsMayCallBrokerApiDirectly: false,
      commandSurface: "openclaw_telegram_codex_claude_to_live_executor_intent",
      brokerWriteSurface: "live_executor_only_after_gates",
      armProfilePath: armProfile.paths.profilePath,
      armProfileStatus: armProfile.status,
      enablementGates: [
        "fresh_quote",
        "verified_position_snapshot",
        "live_executor_arm_profile",
        "strategy_promotion_gate",
        "pretrade_risk_gate",
        "external_adapter_ack_hash_match",
        "canary_pass",
        "rollback_fresh",
        "runtime_live_enabled",
      ],
    },
    liveOrderShape: {
      brokerApi: dryRun.liveOrderDraft?.brokerApi || "",
      brokerStruct: dryRun.liveOrderDraft?.brokerStruct || "",
      symbol: dryRun.liveOrderDraft?.commandPayload?.stockNo || "",
      qty: dryRun.liveOrderDraft?.commandPayload?.qty ?? null,
      dayTradeMode: dryRun.liveOrderDraft?.commandPayload?.dayTradeMode || "",
      supportedModes: dryRun.liveOrderDraft?.supportedModes || [],
      accountAllowlistCount: dryRun.liveOrderDraft?.accountAllowlist?.count ?? 0,
    },
    preTradeRiskGate: {
      attachedBeforeBrokerSend: dryRun.preTradeRiskGate?.attachedBeforeBrokerSend === true,
      evaluated: dryRun.preTradeRiskGate?.evaluated === true,
      allowedToSend: false,
      blockerCount: uniqueBlockers.length,
      blockers: uniqueBlockers,
    },
    approval: {
      status: approvalSummary.status,
      humanApproved: approvalSummary.approval?.humanApproved === true,
      accountAllowlistCount: approvalSummary.approval?.accountAllowlistCount ?? 0,
      killSwitch: approvalSummary.approval?.killSwitch === true,
      rollbackPlanFilled: approvalSummary.approval?.rollbackPlanFilled === true,
    },
    promotionGate: {
      status: promotionGate.status,
      blockerCode: promotionGate.blockerCode,
      readyForManualReview: promotionGate.readyForManualReview === true,
      blockers: promotionGate.blockers || [],
    },
    liveExecutorArmProfile: {
      status: armProfile.status,
      armed: armProfile.armed === true,
      allowExecutorWrite: armProfile.allowBrokerWriteWhenAllGatesPass === true,
      allowConversationAgentDirectWrite: armProfile.allowConversationAgentDirectWrite === true,
      brokerWriteAuthorityTarget: armProfile.brokerWriteAuthorityTarget,
      expiresAt: armProfile.expiresAt,
      blockers: armProfile.blockers,
      machineLine: armProfile.machineLine,
      paths: armProfile.paths,
      safety: armProfile.safety,
    },
    operationPath,
    safety: {
      liveTradingEnabled: false,
      brokerWriteAllowed: false,
      liveExecutorSupported: true,
      liveExecutorArmed: armProfile.allowBrokerWriteWhenAllGatesPass === true,
      brokerWriteAllowedWhenArmed: true,
      externalWriteAllowed: false,
      brokerOrderPathEnabled: false,
      loginAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      automationMayPromoteLive: false,
    },
    nextSafeTask:
      armProfile.allowBrokerWriteWhenAllGatesPass === true
        ? "Rerun live readiness, adapter ack, canary, rollback, and promotion gates before local executor dispatch."
        : "Fill and review .openclaw/trading/capital-live-executor-arm-profile.json, then rerun pnpm capital:trade:live-executor-profile:check.",
  };
}

async function main() {
  const reportPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  const markdownPath = path.resolve(argValue("--markdown", DEFAULT_MD_PATH));
  const report = await buildCapitalLiveOperationCapability();

  if (hasFlag("--write-state")) {
    await writeJsonWithSha(reportPath, report);
    await writeTextWithSha(markdownPath, buildMarkdown(report));
  }

  if (hasFlag("--check") && report.status !== "capability_ready_live_executor_gated") {
    throw new Error(`CAPITAL_LIVE_OPERATION_CAPABILITY_UNEXPECTED_STATUS status=${report.status}`);
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      "OpenClaw Capital live operation capability",
      `status=${report.status}`,
      `brokerApi=${report.liveOrderShape.brokerApi}`,
      `symbol=${report.liveOrderShape.symbol}`,
      `sentOrder=${report.safety.sentOrder}`,
      `blockerCode=${report.blockerCode}`,
      `nextSafeTask=${report.nextSafeTask}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital live operation capability failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
