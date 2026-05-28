import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOkxOrderStatusGate } from "./openclaw-okx-order-status-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-demo-order-simulation-result-gate-latest.json",
);
const ORDER_STATUS_REPORT_PATH =
  "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json";
const DEFAULT_INST_ID = "BTC-USDT";

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

function buildBlockers(orderStatus) {
  const blockers = [];
  const simulation = orderStatus.demoSimulation ?? {};
  const simulatedOrder = simulation.simulatedOrder ?? {};
  const simulatedCancel = simulation.simulatedCancel ?? {};
  const safety = simulation.safety ?? {};
  if (orderStatus.schema !== "openclaw.okx.order-status-gate.v1") {
    blockers.push("order_status_schema_blocked");
  }
  if (!["ready_read_only", "blocked"].includes(orderStatus.status)) {
    blockers.push("order_status_unknown");
  }
  if (simulation.schema !== "openclaw.okx.demo-order-simulation.v1") {
    blockers.push("demo_simulation_schema_blocked");
  }
  if (simulatedOrder.submittedOrder !== false) {
    blockers.push("submitted_order_not_false");
  }
  if (simulatedOrder.exchangeWriteAttempted !== false) {
    blockers.push("exchange_write_attempted");
  }
  if (simulatedOrder.orderStatusQueryExecuted !== false) {
    blockers.push("order_status_query_executed");
  }
  if (simulatedCancel.exchangeCancelAttempted !== false) {
    blockers.push("exchange_cancel_attempted");
  }
  if (simulatedCancel.cancelSubmitted !== false) {
    blockers.push("cancel_submitted");
  }
  if (safety.liveTradingEnabled !== false || safety.writeTradingEnabled !== false) {
    blockers.push("write_or_live_enabled");
  }
  return unique(blockers);
}

export async function buildOkxDemoOrderSimulationResultGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const instId = options.instId || DEFAULT_INST_ID;
  const orderStatus = await buildOkxOrderStatusGate({ instId, now: options.now });
  const blockers = buildBlockers(orderStatus);
  const simulation = orderStatus.demoSimulation ?? {};
  const simulatedOrder = simulation.simulatedOrder ?? {};
  const simulatedCancel = simulation.simulatedCancel ?? {};
  const ready = blockers.length === 0;
  const code = ready
    ? "demo_order_simulation_result_ready"
    : "demo_order_simulation_result_blocked";

  return {
    schema: "openclaw.okx.demo-order-simulation-result-gate.v1",
    generatedAt,
    provider: "okx",
    language: "zh-TW",
    mode: "local_demo_order_simulation_result_only",
    status: ready ? "ready_no_exchange_write" : "blocked",
    code,
    summary_zh_tw: ready
      ? "OKX demo-only 模擬結果可讀；沒有交易寫入、查單或撤單。"
      : `OKX demo-only 模擬結果阻擋：${blockers.join("、")}。`,
    blockers,
    markers: unique([
      code,
      "demo_only",
      "local_simulation_only",
      "submitted_order_false",
      "exchange_write_false",
      "order_status_query_false",
      "cancel_submitted_false",
      simulation.code,
      ...blockers,
    ]),
    dependsOn: {
      orderStatusGate: ORDER_STATUS_REPORT_PATH,
      orderStatusSchema: orderStatus.schema,
      orderStatusGeneratedAt: orderStatus.generatedAt,
      orderStatusCode: orderStatus.code,
    },
    result: {
      profile: simulation.profile || "demo",
      instId,
      simulationCode: simulation.code || "",
      simulationStatus: simulation.status || "",
      simulatedClientOrderId: simulatedOrder.simulatedClientOrderId || "",
      exchangeOrderId: simulatedOrder.exchangeOrderId || "",
      orderStatus: simulatedOrder.orderStatus || "",
      fillStatus: simulatedOrder.fillStatus || "",
      cancelStatus: simulatedCancel.cancelStatus || "",
    },
    safety: {
      demoOnly: true,
      readOnly: true,
      dryRunOnly: true,
      localSimulationOnly: true,
      executionAllowed: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      orderPlacementEnabled: false,
      submittedOrder: false,
      exchangeWriteAttempted: false,
      orderStatusQueryExecuted: false,
      cancelOrderEnabled: false,
      cancelSubmitted: false,
      exchangeCancelAttempted: false,
      amendOrderEnabled: false,
      withdrawalEnabled: false,
      credentialEchoed: false,
      storesSecretsInRepo: false,
    },
    commands: {
      executed: ["okx order status gate dependency", "OpenClaw local demo simulation only"],
      notExecuted: [
        "GET /api/v5/trade/order",
        "GET /api/v5/trade/orders-pending",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
      forbidden: [
        "okx spot place",
        "okx swap place",
        "okx futures place",
        "okx spot cancel",
        "okx swap cancel",
        "POST /api/v5/trade/order",
        "POST /api/v5/trade/cancel-order",
      ],
    },
    rollbackPath: [
      "Remove package scripts okx:demo-simulation and okx:demo-simulation:check.",
      "Delete scripts/openclaw-okx-demo-order-simulation-result-gate.mjs and scripts/check-openclaw-okx-demo-order-simulation-result-gate.mjs.",
      "Delete reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json and .sha256.",
      "Remove OKX demo-simulation references from skills/openclaw-okx-cex-status/SKILL.md.",
    ],
    nextSafeTask: ready
      ? "把 demo-only simulation result 接到 OKX paper audit log；仍不送 live order。"
      : "先修復 demo simulation blocker，再重跑 okx:demo-simulation:check。",
  };
}

async function main() {
  const report = await buildOkxDemoOrderSimulationResultGate({
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
      `okx demo order simulation result gate failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
