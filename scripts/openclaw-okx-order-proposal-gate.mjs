import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkxApiStatusGate } from "./openclaw-okx-api-status-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-order-proposal-gate-latest.json",
);
const STATUS_REPORT_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-api-status-gate-latest.json",
);
const PAPER_SIGNAL_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-paper-signal-gate-latest.json",
);
const PAPER_SIGNAL_DEPENDS_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-paper-signal-gate-latest.json",
);
const DEFAULT_INST_ID = "BTC-USDT";
const DEFAULT_SIDE = "buy";
const DEFAULT_ORDER_TYPE = "market";
const DEFAULT_TD_MODE = "cash";
const POLICY_WARNINGS = [
  "chat_supplied_secret_must_rotate",
  "withdraw_permission_blocked",
  "blank_ip_with_trade_or_withdraw_blocked",
];

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

async function writeJsonWithHash(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function buildBlockers(statusReport) {
  const blockers = [];
  if (statusReport.schema !== "openclaw.okx.api-status-gate.v1") {
    blockers.push("api_status_schema_blocked");
  }
  if (statusReport.quote?.code !== "quote_ok") {
    blockers.push("quote_not_ready");
  }
  if (statusReport.openclawSkill?.code !== "openclaw_skill_ok") {
    blockers.push("openclaw_skill_not_ready");
  }
  if (statusReport.authentication?.demo?.code !== "demo_ok") {
    blockers.push(statusReport.authentication?.demo?.code || "demo_missing");
  }
  return unique(blockers);
}

function buildPolicyWarnings(statusReport) {
  const warnings = [];
  for (const warning of POLICY_WARNINGS) {
    if (statusReport.markers?.includes(warning) || statusReport.blockers?.includes(warning)) {
      warnings.push(warning);
    }
  }
  return unique(warnings);
}

function toNonEmptyText(value) {
  const text = String(value || "").trim();
  return text.length > 0 ? text : "";
}

function inferMarketFromInstType(instType) {
  const normalized = String(instType || "").toUpperCase();
  if (normalized === "SWAP") {
    return "swap";
  }
  if (normalized === "FUTURES") {
    return "futures";
  }
  if (normalized === "OPTION") {
    return "option";
  }
  return "spot";
}

function buildSignalPrefill({ paperSignalReport, requestedInstId, requestedSide }) {
  const cliInstId = toNonEmptyText(requestedInstId);
  const cliSide = toNonEmptyText(requestedSide);
  if (cliInstId) {
    return {
      instId: cliInstId,
      side: cliSide || DEFAULT_SIDE,
      market: "spot",
      signalPrefill: {
        source: "cli_override",
        sourceReport: PAPER_SIGNAL_DEPENDS_PATH.split(path.sep).join("/"),
        sourceSchema: paperSignalReport?.schema || "",
        sourceGeneratedAt: paperSignalReport?.generatedAt || "",
        usedCandidate: false,
        reason: "inst_id_overridden_by_cli",
        action: paperSignalReport?.signal?.action || "",
        selectedInstId: cliInstId,
        selectedInstType: "",
        selectedScore: 0,
      },
    };
  }

  const candidate =
    paperSignalReport?.signal?.topCandidates?.find((item) => toNonEmptyText(item?.instId)) || null;
  const candidateInstId = toNonEmptyText(candidate?.instId);
  const action = toNonEmptyText(paperSignalReport?.signal?.action);
  const sideFromAction = action === "paper_watch_short" ? "sell" : "buy";

  if (!candidateInstId) {
    return {
      instId: DEFAULT_INST_ID,
      side: cliSide || DEFAULT_SIDE,
      market: "spot",
      signalPrefill: {
        source: "default_fallback",
        sourceReport: PAPER_SIGNAL_DEPENDS_PATH.split(path.sep).join("/"),
        sourceSchema: paperSignalReport?.schema || "",
        sourceGeneratedAt: paperSignalReport?.generatedAt || "",
        usedCandidate: false,
        reason: "paper_signal_candidate_missing",
        action,
        selectedInstId: DEFAULT_INST_ID,
        selectedInstType: "",
        selectedScore: 0,
      },
    };
  }

  return {
    instId: candidateInstId,
    side: cliSide || sideFromAction,
    market: inferMarketFromInstType(candidate?.instType),
    signalPrefill: {
      source: "paper_signal_top_candidate",
      sourceReport: PAPER_SIGNAL_DEPENDS_PATH.split(path.sep).join("/"),
      sourceSchema: paperSignalReport?.schema || "",
      sourceGeneratedAt: paperSignalReport?.generatedAt || "",
      usedCandidate: true,
      reason: "top_candidate_prefilled_for_dry_run",
      action,
      selectedInstId: candidateInstId,
      selectedInstType: toNonEmptyText(candidate?.instType),
      selectedScore: Number.isFinite(candidate?.score) ? candidate.score : 0,
    },
  };
}

export async function buildOkxOrderProposalGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const paperSignalReport = await readJsonIfExists(PAPER_SIGNAL_REPORT_PATH);
  const signalPrefill = buildSignalPrefill({
    paperSignalReport,
    requestedInstId: options.instId,
    requestedSide: options.side,
  });
  const statusReport = await buildOkxApiStatusGate({
    symbol: signalPrefill.instId,
    now: options.now,
  });
  const blockers = buildBlockers(statusReport);
  const policyWarnings = buildPolicyWarnings(statusReport);
  const proposalCode =
    blockers.length === 0 ? "dry_run_proposal_ready_for_manual_review" : "dry_run_proposal_blocked";
  const instId = signalPrefill.instId;
  const side = signalPrefill.side;
  const market = signalPrefill.market;
  const ordType = options.ordType || DEFAULT_ORDER_TYPE;
  const tdMode = options.tdMode || DEFAULT_TD_MODE;

  return {
    schema: "openclaw.okx.order-proposal-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "dry_run_proposal_only",
    code: proposalCode,
    status: blockers.length === 0 ? "proposal_ready_no_policy_block" : "blocked",
    summary_zh_tw:
      blockers.length === 0
        ? policyWarnings.length === 0
          ? "OKX dry-run 下單提案可供人工審核；實際送單仍停用。"
          : `OKX dry-run 下單提案可供人工審核；政策警示：${policyWarnings.join("、")}；實際送單仍停用。`
        : `OKX dry-run 下單提案已阻擋：${blockers.join("、")}。`,
    blockers,
    policyWarnings,
    markers: unique([
      proposalCode,
      "execution_not_enabled",
      "submission_command_empty",
      "submitted_order_false",
      ...blockers,
      ...policyWarnings,
    ]),
    dependsOn: {
      apiStatusGate: STATUS_REPORT_PATH.split(path.sep).join("/"),
      paperSignalGate: PAPER_SIGNAL_DEPENDS_PATH.split(path.sep).join("/"),
      apiStatusSchema: statusReport.schema,
      paperSignalSchema: paperSignalReport?.schema || "",
      apiStatusGeneratedAt: statusReport.generatedAt,
      paperSignalGeneratedAt: paperSignalReport?.generatedAt || "",
      apiStatusMarkers: statusReport.markers,
      apiStatusBlockers: statusReport.blockers,
    },
    signalPrefill: signalPrefill.signalPrefill,
    requestedOrder: {
      profile: "demo",
      market,
      instId,
      side,
      ordType,
      tdMode,
      size: "0",
      sizeMeaning: "zero_size_non_actionable_placeholder",
      tgtCcy: "",
      px: "",
      clientOrderId: "",
      isActionableOrder: false,
    },
    quoteContext: {
      source: statusReport.quote?.source || "",
      readOnly: true,
      instId: statusReport.quote?.instId || "",
      last: statusReport.quote?.last || "",
      bidPx: statusReport.quote?.bidPx || "",
      askPx: statusReport.quote?.askPx || "",
      ts: statusReport.quote?.ts || "",
    },
    preTradeChecks: {
      apiStatusSchemaOk: statusReport.schema === "openclaw.okx.api-status-gate.v1",
      quoteOk: statusReport.quote?.code === "quote_ok",
      demoAuthOk: statusReport.authentication?.demo?.code === "demo_ok",
      liveAuthInformationalOnly: statusReport.authentication?.live?.code || "live_missing",
      openclawSkillOk: statusReport.openclawSkill?.code === "openclaw_skill_ok",
      chatPostedKeyRotated: !policyWarnings.includes("chat_supplied_secret_must_rotate"),
      withdrawPermissionAbsent: !policyWarnings.includes("withdraw_permission_blocked"),
      ipAllowlistSafe: !policyWarnings.includes("blank_ip_with_trade_or_withdraw_blocked"),
    },
    safety: {
      dryRunOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      withdrawalEnabled: false,
      orderPlacementEnabled: false,
      cancelOrderEnabled: false,
      amendOrderEnabled: false,
      submittedOrder: false,
      submissionCommand: "",
      credentialEchoed: false,
      storesSecretsInRepo: false,
      requiresHumanApprovalGateBeforeWrites: true,
      requiresSeparatePromotionGateBeforeLive: true,
    },
    commands: {
      executed: ["okx api status gate read-only dependency"],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "okx spot amend",
        "okx swap amend",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:order-proposal and okx:order-proposal:check.",
      "Delete scripts/openclaw-okx-order-proposal-gate.mjs and scripts/check-openclaw-okx-order-proposal-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json and .sha256.",
      "Remove OKX order proposal references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask:
      blockers.length === 0
        ? "建立 demo-only order simulation result gate；仍然不送 live order。"
        : "撤銷已貼出的 OKX key，重建 read-only 且綁定 IP 的 key，填入本機 .okx/config.toml，再重跑 okx:api-status:check 與 okx:order-proposal:check。",
  };
}

async function main() {
  const report = await buildOkxOrderProposalGate({
    instId: argValue("--inst-id", DEFAULT_INST_ID),
    side: argValue("--side", DEFAULT_SIDE),
    ordType: argValue("--ord-type", DEFAULT_ORDER_TYPE),
    tdMode: argValue("--td-mode", DEFAULT_TD_MODE),
  });
  const outputPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  if (hasFlag("--write-state")) {
    await writeJsonWithHash(outputPath, report);
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.summary_zh_tw}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `okx order proposal gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
