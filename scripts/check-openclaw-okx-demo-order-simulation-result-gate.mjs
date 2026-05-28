import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxDemoOrderSimulationResultGate } from "./openclaw-okx-demo-order-simulation-result-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:demo-simulation"],
  "node scripts/openclaw-okx-demo-order-simulation-result-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:demo-simulation:check"],
  "node scripts/check-openclaw-okx-demo-order-simulation-result-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-demo-order-simulation-result-gate-latest.json",
);
const report = await buildOkxDemoOrderSimulationResultGate();

assert.equal(report.schema, "openclaw.okx.demo-order-simulation-result-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "local_demo_order_simulation_result_only");
assert.ok(["ready_no_exchange_write", "blocked"].includes(report.status));
assert.ok(
  ["demo_order_simulation_result_ready", "demo_order_simulation_result_blocked"].includes(
    report.code,
  ),
);
assert.equal(
  report.dependsOn.orderStatusGate,
  "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
);
assert.equal(report.dependsOn.orderStatusSchema, "openclaw.okx.order-status-gate.v1");
assert.equal(report.result.profile, "demo");
assert.ok(report.result.instId.length > 0);
assert.match(report.result.simulatedClientOrderId, /^openclaw-okx-demo-sim-/u);
assert.equal(report.result.exchangeOrderId, "");
assert.equal(report.safety.demoOnly, true);
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.dryRunOnly, true);
assert.equal(report.safety.localSimulationOnly, true);
assert.equal(report.safety.executionAllowed, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.exchangeWriteAttempted, false);
assert.equal(report.safety.orderStatusQueryExecuted, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.cancelSubmitted, false);
assert.equal(report.safety.exchangeCancelAttempted, false);
assert.equal(report.safety.amendOrderEnabled, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.credentialEchoed, false);
assert.equal(report.safety.storesSecretsInRepo, false);
assert.ok(report.commands.executed.includes("okx order status gate dependency"));
assert.ok(report.commands.executed.includes("OpenClaw local demo simulation only"));
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.markers.includes("demo_only"));
assert.ok(report.markers.includes("local_simulation_only"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("exchange_write_false"));
assert.ok(report.markers.includes("order_status_query_false"));
assert.ok(report.markers.includes("cancel_submitted_false"));
assert.match(report.summary_zh_tw, /OKX demo-only/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /audit log|blocker/u);

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
    "OKX_DEMO_ORDER_SIMULATION_RESULT_GATE_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
