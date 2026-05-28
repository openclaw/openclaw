import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxCurrentReadinessSummary } from "./openclaw-okx-current-readiness-summary.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:current-readiness"],
  "node scripts/openclaw-okx-current-readiness-summary.mjs --write-state --json",
);
assert.equal(
  scripts["okx:current-readiness:check"],
  "node scripts/check-openclaw-okx-current-readiness-summary.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-current-readiness-summary-latest.json",
);

const report = await buildOkxCurrentReadinessSummary();
assert.equal(report.schema, "openclaw.okx.current-readiness-summary.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "read_only_current_readiness_summary");
assert.equal(report.status, "ready_read_only");
assert.equal(report.code, "okx_current_readiness_ready");
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.summaryOnly, true);
assert.equal(report.safety.paperOnly, true);
assert.equal(report.safety.demoOnly, true);
assert.equal(report.safety.sourceFreshnessChecked, true);
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
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.noOrderWrite, true);
assert.equal(report.readiness.marketSnapshot.ok, true);
assert.equal(report.readiness.marketSnapshotScheduler.ok, true);
assert.equal(report.readiness.demoSimulation.ok, true);
assert.equal(report.readiness.paperAuditSummary.ok, true);
assert.equal(report.readiness.telegramClosure.ok, true);
assert.equal(report.readiness.demoSimulation.submittedOrder, false);
assert.equal(report.readiness.demoSimulation.exchangeWriteAttempted, false);
assert.equal(report.readiness.demoSimulation.orderStatusQueryExecuted, false);
assert.equal(report.readiness.demoSimulation.cancelSubmitted, false);
assert.equal(report.readiness.paperAuditSummary.submittedOrder, 0);
assert.equal(report.readiness.paperAuditSummary.exchangeWriteAttempted, 0);
assert.equal(report.readiness.paperAuditSummary.orderStatusQueryExecuted, 0);
assert.equal(report.readiness.paperAuditSummary.cancelSubmitted, 0);
assert.equal(report.readiness.telegramClosure.noOrderWrite, true);
assert.equal(report.readiness.marketSnapshotScheduler.noOrderWrite, true);
assert.equal(report.readiness.marketSnapshotScheduler.nextRunWithinGrace, true);
assert.match(report.readiness.marketSnapshotScheduler.nextRunAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.match(report.readiness.marketSnapshotScheduler.machineLine, /nextRunAt=\d{4}-\d{2}-\d{2}T/u);
assert.equal(report.sourceFreshness.ok, true);
assert.equal(report.sourceFreshness.marketSnapshot.status, "fresh");
assert.equal(report.sourceFreshness.marketSnapshotScheduler.status, "fresh");
assert.equal(report.sourceFreshness.demoSimulation.status, "fresh");
assert.equal(report.sourceFreshness.paperAuditSummary.status, "fresh");
assert.equal(report.sourceFreshness.telegramClosure.status, "fresh");
assert.equal(
  report.readTargets.marketSnapshot,
  "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json",
);
assert.equal(
  report.readTargets.marketSnapshotScheduler,
  "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
);
assert.equal(
  report.readTargets.demoSimulation,
  "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
);
assert.equal(
  report.readTargets.paperAuditSummary,
  "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
);
assert.equal(
  report.readTargets.telegramShortcuts,
  "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
);
assert.ok(report.markers.includes("okx_current_readiness_ready"));
assert.ok(report.markers.includes("quote_snapshot_ok"));
assert.ok(report.markers.includes("market_snapshot_scheduler_ready"));
assert.ok(report.markers.includes("demo_simulation_ready"));
assert.ok(report.markers.includes("paper_audit_summary_ready"));
assert.ok(report.markers.includes("telegram_closure_ready"));
assert.ok(report.markers.includes("source_freshness_ok"));
assert.ok(report.markers.includes("market_snapshot_fresh"));
assert.ok(report.markers.includes("market_snapshot_scheduler_fresh"));
assert.ok(report.markers.includes("market_snapshot_scheduler_next_run_current"));
assert.ok(report.markers.includes("demo_simulation_fresh"));
assert.ok(report.markers.includes("paper_audit_summary_fresh"));
assert.ok(report.markers.includes("telegram_closure_fresh"));
assert.ok(report.markers.includes("read_only_current_summary"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("exchange_write_false"));
assert.ok(report.markers.includes("order_status_query_false"));
assert.ok(report.markers.includes("cancel_submitted_false"));
assert.match(report.machineLine, /okxCurrentReadiness=ready/u);
assert.match(report.machineLine, /quote=ok/u);
assert.match(report.machineLine, /scheduler=pass/u);
assert.match(report.machineLine, /schedulerNextRunAt=\d{4}-\d{2}-\d{2}T/u);
assert.match(report.machineLine, /demo=ready_no_exchange_write/u);
assert.match(report.machineLine, /paperAudit=ready_read_only/u);
assert.match(report.machineLine, /telegram=pass/u);
assert.match(report.machineLine, /freshness=ok/u);
assert.match(report.machineLine, /noOrderWrite=true/u);
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/orders-pending"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.equal(report.blockers.length, 0);
assert.match(report.summary_zh_tw, /OKX current-readiness/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 4);
assert.match(report.nextSafeTask, /refresh|source/u);

const staleReport = await buildOkxCurrentReadinessSummary({
  now: new Date("2099-01-01T00:00:00.000Z"),
  sourceFreshnessLimitsMs: {
    marketSnapshot: 1,
    demoSimulation: 1,
    paperAuditSummary: 1,
    telegramClosure: 1,
  },
});
assert.equal(staleReport.status, "blocked");
assert.equal(staleReport.code, "okx_current_readiness_blocked");
assert.equal(staleReport.sourceFreshness.ok, false);
assert.ok(staleReport.blockers.includes("market_snapshot_stale"));
assert.ok(staleReport.blockers.includes("market_snapshot_scheduler_stale"));
assert.ok(staleReport.blockers.includes("market_snapshot_scheduler_next_run_stale"));
assert.ok(staleReport.blockers.includes("demo_simulation_stale"));
assert.ok(staleReport.blockers.includes("paper_audit_summary_stale"));
assert.ok(staleReport.blockers.includes("telegram_closure_stale"));
assert.ok(staleReport.markers.includes("source_freshness_stale"));
assert.ok(staleReport.markers.includes("market_snapshot_scheduler_stale"));
assert.ok(staleReport.markers.includes("market_snapshot_scheduler_next_run_stale"));
assert.match(staleReport.machineLine, /freshness=stale/u);

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
    "OKX_CURRENT_READINESS_SUMMARY_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `machineLine=${report.machineLine}`,
    `blockers=${report.blockers.join("/")}`,
    `report=reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
