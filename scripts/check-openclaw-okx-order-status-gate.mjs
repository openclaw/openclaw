import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxOrderStatusGate } from "./openclaw-okx-order-status-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:order-status"],
  "node scripts/openclaw-okx-order-status-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:order-status:check"],
  "node scripts/check-openclaw-okx-order-status-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-order-status-gate-latest.json",
);
const report = await buildOkxOrderStatusGate();

assert.equal(report.schema, "openclaw.okx.order-status-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "read_only_order_lifecycle_status");
assert.ok(["ready_read_only", "blocked"].includes(report.status));
assert.ok(
  [
    "order_lifecycle_read_only_ready",
    "no_submitted_order_to_track",
    "order_lifecycle_blocked",
  ].includes(report.code),
);
assert.equal(
  report.dependsOn.apiStatusGate,
  "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json",
);
assert.equal(
  report.dependsOn.orderProposalGate,
  "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
);
assert.equal(report.dependsOn.apiStatusSchema, "openclaw.okx.api-status-gate.v1");
assert.equal(report.dependsOn.orderProposalSchema, "openclaw.okx.order-proposal-gate.v1");
assert.equal(report.officialEndpointMap.orderDetails.method, "GET");
assert.equal(report.officialEndpointMap.orderDetails.path, "/api/v5/trade/order");
assert.equal(report.officialEndpointMap.orderDetails.permission, "Read");
assert.equal(report.officialEndpointMap.pendingOrders.path, "/api/v5/trade/orders-pending");
assert.equal(report.officialEndpointMap.pendingOrders.permission, "Read");
assert.equal(report.officialEndpointMap.cancelOrder.method, "POST");
assert.equal(report.officialEndpointMap.cancelOrder.path, "/api/v5/trade/cancel-order");
assert.equal(report.officialEndpointMap.cancelOrder.permission, "Trade");
assert.equal(report.trackedOrder.profile, "demo");
assert.ok(typeof report.trackedOrder.instId === "string");
assert.ok(report.trackedOrder.instId.length > 0);
assert.equal(report.trackedOrder.ordId, "");
assert.equal(report.trackedOrder.clOrdId, "");
assert.equal(report.trackedOrder.submittedOrder, false);
assert.equal(report.trackedOrder.orderStatus, "none");
assert.equal(report.trackedOrder.queryEnabled, false);
assert.equal(report.demoSimulation.schema, "openclaw.okx.demo-order-simulation.v1");
assert.equal(report.demoSimulation.profile, "demo");
assert.equal(report.demoSimulation.mode, "local_demo_simulation_no_exchange_write");
assert.ok(
  ["simulation_blocked_by_pretrade_gate", "simulation_ready_no_submission"].includes(
    report.demoSimulation.status,
  ),
);
assert.ok(
  ["demo_simulation_blocked", "demo_simulation_no_exchange_write"].includes(
    report.demoSimulation.code,
  ),
);
assert.equal(report.demoSimulation.requestedOrder.profile, "demo");
assert.equal(report.demoSimulation.requestedOrder.instId, report.trackedOrder.instId);
assert.equal(report.demoSimulation.requestedOrder.isActionableOrder, false);
assert.match(
  report.demoSimulation.simulatedOrder.simulatedClientOrderId,
  /^openclaw-okx-demo-sim-/u,
);
assert.equal(report.demoSimulation.simulatedOrder.exchangeOrderId, "");
assert.equal(report.demoSimulation.simulatedOrder.submittedOrder, false);
assert.equal(report.demoSimulation.simulatedOrder.exchangeWriteAttempted, false);
assert.equal(report.demoSimulation.simulatedOrder.orderStatusQueryExecuted, false);
assert.equal(report.demoSimulation.simulatedCancel.cancelOrderEnabled, false);
assert.equal(report.demoSimulation.simulatedCancel.cancelSubmitted, false);
assert.equal(report.demoSimulation.simulatedCancel.exchangeCancelAttempted, false);
assert.equal(report.demoSimulation.safety.demoOnly, true);
assert.equal(report.demoSimulation.safety.readOnly, true);
assert.equal(report.demoSimulation.safety.executionAllowed, false);
assert.equal(report.demoSimulation.safety.orderPlacementEnabled, false);
assert.equal(report.demoSimulation.safety.submittedOrder, false);
assert.equal(report.cancelStatus.cancelOrderEnabled, false);
assert.equal(report.cancelStatus.cancelSubmitted, false);
assert.equal(report.cancelStatus.cancelStatus, "not_applicable");
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.dryRunOnly, true);
assert.equal(report.safety.executionAllowed, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.orderStatusQueryExecuted, false);
assert.equal(report.safety.demoSimulationExecuted, true);
assert.equal(report.safety.exchangeWriteAttempted, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.cancelSubmitted, false);
assert.equal(report.safety.amendOrderEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.ok(report.commands.executed.includes("okx api status gate dependency"));
assert.ok(report.commands.executed.includes("okx order proposal gate dependency"));
assert.ok(report.commands.executed.includes("OpenClaw local demo simulation only"));
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.markers.includes("order_status_read_only"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("cancel_not_enabled"));
assert.ok(
  report.markers.includes("demo_simulation_blocked") ||
    report.markers.includes("demo_simulation_no_exchange_write"),
);
assert.match(report.summary_zh_tw, /OKX 訂單\/撤單狀態/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /OKX key|demo-only/u);

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const payload = `${JSON.stringify(report, null, 2)}\n`;
await fs.writeFile(reportPath, payload, "utf8");
await fs.writeFile(
  `${reportPath}.sha256`,
  `${crypto.createHash("sha256").update(payload).digest("hex").toUpperCase()}\n`,
  "ascii",
);

process.stdout.write(
  [
    "OKX_ORDER_STATUS_GATE_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
