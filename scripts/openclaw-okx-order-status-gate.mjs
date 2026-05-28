import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkxApiStatusGate } from "./openclaw-okx-api-status-gate.mjs";
import { buildOkxOrderProposalGate } from "./openclaw-okx-order-proposal-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-order-status-gate-latest.json",
);
const API_STATUS_REPORT_PATH =
  "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json";
const ORDER_PROPOSAL_REPORT_PATH =
  "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json";
const DEFAULT_INST_ID = "BTC-USDT";

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

function buildBlockers({ apiStatus, orderProposal }) {
  const blockers = [];
  if (apiStatus.schema !== "openclaw.okx.api-status-gate.v1") {
    blockers.push("api_status_schema_blocked");
  }
  if (orderProposal.schema !== "openclaw.okx.order-proposal-gate.v1") {
    blockers.push("order_proposal_schema_blocked");
  }
  if (apiStatus.quote?.code !== "quote_ok") {
    blockers.push("quote_not_ready");
  }
  if (apiStatus.authentication?.demo?.code !== "demo_ok") {
    blockers.push(apiStatus.authentication?.demo?.code || "demo_missing");
  }
  if (orderProposal.safety?.submittedOrder !== false) {
    blockers.push("submitted_order_state_unknown");
  }
  if (orderProposal.safety?.executionAllowed !== false) {
    blockers.push("execution_state_unknown");
  }
  if (orderProposal.safety?.cancelOrderEnabled !== false) {
    blockers.push("cancel_state_unknown");
  }
  if (orderProposal.requestedOrder?.isActionableOrder !== false) {
    blockers.push("actionable_order_not_allowed");
  }
  if (orderProposal.requestedOrder?.size !== "0") {
    blockers.push("non_zero_order_size_not_allowed");
  }
  return unique(blockers);
}

function buildPolicyWarnings({ apiStatus, orderProposal }) {
  const warnings = [];
  for (const warning of POLICY_WARNINGS) {
    if (apiStatus.markers?.includes(warning) || orderProposal.markers?.includes(warning)) {
      warnings.push(warning);
    }
  }
  return unique(warnings);
}

function simulationIdFor({ generatedAt, instId, orderProposal }) {
  return `openclaw-okx-demo-sim-${sha256Text(
    JSON.stringify({
      generatedAt,
      instId,
      requestedOrder: orderProposal.requestedOrder ?? {},
      code: orderProposal.code ?? "",
    }),
  ).slice(0, 16)}`;
}

function buildDemoSimulation({ generatedAt, instId, blockers, orderProposal }) {
  const blocked = blockers.length > 0;
  const simulatedClientOrderId = simulationIdFor({ generatedAt, instId, orderProposal });
  return {
    schema: "openclaw.okx.demo-order-simulation.v1",
    generatedAt,
    profile: "demo",
    mode: "local_demo_simulation_no_exchange_write",
    status: blocked ? "simulation_blocked_by_pretrade_gate" : "simulation_ready_no_submission",
    code: blocked ? "demo_simulation_blocked" : "demo_simulation_no_exchange_write",
    blockers,
    requestedOrder: {
      ...orderProposal.requestedOrder,
      profile: "demo",
      instId,
      isActionableOrder: false,
    },
    simulatedOrder: {
      simulatedClientOrderId,
      exchangeOrderId: "",
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatus: blocked ? "blocked_before_exchange" : "simulated_not_submitted",
      fillStatus: "not_applicable",
      orderStatusQueryExecuted: false,
      orderStatusQueryReason: "no_exchange_order_id_because_submission_is_disabled",
    },
    simulatedCancel: {
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      cancelStatus: "not_applicable",
      cancelReason: "cancel_requires_real_exchange_order_id_and_trade_permission",
    },
    safety: {
      demoOnly: true,
      readOnly: true,
      dryRunOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      amendOrderEnabled: false,
      withdrawalEnabled: false,
      submissionCommand: "",
      credentialEchoed: false,
    },
  };
}

export async function buildOkxOrderStatusGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const instId = options.instId || DEFAULT_INST_ID;
  const [apiStatus, orderProposal] = await Promise.all([
    buildOkxApiStatusGate({ symbol: instId, now: options.now }),
    buildOkxOrderProposalGate({ instId, now: options.now }),
  ]);
  const blockers = buildBlockers({ apiStatus, orderProposal });
  const policyWarnings = buildPolicyWarnings({ apiStatus, orderProposal });
  const hasPolicyWarnings = policyWarnings.length > 0;
  const noSubmittedOrder = !orderProposal.safety?.submittedOrder;
  const demoSimulation = buildDemoSimulation({ generatedAt, instId, blockers, orderProposal });
  const code =
    blockers.length === 0
      ? "order_lifecycle_read_only_ready"
      : noSubmittedOrder
        ? "no_submitted_order_to_track"
        : "order_lifecycle_blocked";

  return {
    schema: "openclaw.okx.order-status-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "read_only_order_lifecycle_status",
    status: blockers.length === 0 ? "ready_read_only" : "blocked",
    code,
    summary_zh_tw: noSubmittedOrder
      ? "OKX 訂單/撤單狀態：沒有已送出的 OpenClaw OKX 訂單可查；撤單保持停用。"
      : `OKX 訂單/撤單狀態已阻擋：${blockers.join("、")}。`,
    blockers,
    policyWarnings,
    markers: unique([
      code,
      "order_status_read_only",
      "submitted_order_false",
      "cancel_not_enabled",
      demoSimulation.code,
      ...blockers,
      ...policyWarnings,
    ]),
    dependsOn: {
      apiStatusGate: API_STATUS_REPORT_PATH,
      orderProposalGate: ORDER_PROPOSAL_REPORT_PATH,
      apiStatusSchema: apiStatus.schema,
      orderProposalSchema: orderProposal.schema,
      apiStatusGeneratedAt: apiStatus.generatedAt,
      orderProposalGeneratedAt: orderProposal.generatedAt,
    },
    officialEndpointMap: {
      orderDetails: {
        method: "GET",
        path: "/api/v5/trade/order",
        permission: "Read",
        docs: "https://www.okx.com/docs-v5/en/",
      },
      pendingOrders: {
        method: "GET",
        path: "/api/v5/trade/orders-pending",
        permission: "Read",
        docs: "https://www.okx.com/docs-v5/en/",
      },
      cancelOrder: {
        method: "POST",
        path: "/api/v5/trade/cancel-order",
        permission: "Trade",
        docs: "https://www.okx.com/docs-v5/en/",
      },
    },
    trackedOrder: {
      profile: "demo",
      market: orderProposal.requestedOrder?.market || "spot",
      instId,
      ordId: "",
      clOrdId: "",
      submittedOrder: false,
      orderStatus: "none",
      queryEnabled: false,
      queryReason: "no_submitted_order_or_order_id",
    },
    demoSimulation,
    cancelStatus: {
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      cancelStatus: "not_applicable",
      cancelReason: "cancel_requires_trade_permission_and_existing_order",
    },
    safety: {
      readOnly: true,
      dryRunOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      orderStatusQueryExecuted: false,
      demoSimulationExecuted: true,
      exchangeWriteAttempted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      amendOrderEnabled: false,
      withdrawalEnabled: false,
      requiresHumanApprovalGateBeforeWrites: true,
      requiresSeparatePromotionGateBeforeLive: true,
    },
    commands: {
      executed: [
        "okx api status gate dependency",
        "okx order proposal gate dependency",
        "OpenClaw local demo simulation only",
      ],
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/cancel-order",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "okx futures cancel",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:order-status and okx:order-status:check.",
      "Delete scripts/openclaw-okx-order-status-gate.mjs and scripts/check-openclaw-okx-order-status-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json and .sha256.",
      "Remove OKX order-status references from skills/openclaw-okx-cex-status/SKILL.md and docs/automation/module-skill-inventory.md.",
    ],
    nextSafeTask: hasPolicyWarnings
      ? "已切換為政策警示不阻擋；可先走 demo-only simulation gate，後續再換正式安全 key。"
      : "建立 demo-only simulated order result gate；仍不送 live order、不撤單。",
  };
}

async function main() {
  const report = await buildOkxOrderStatusGate({
    instId: argValue("--inst-id", DEFAULT_INST_ID),
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
      `okx order status gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
