import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildOkxCurrentReadinessRefreshWorkflow,
  REFRESH_STEPS,
} from "./openclaw-okx-current-readiness-refresh-workflow.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:current-readiness:refresh"],
  "node scripts/openclaw-okx-current-readiness-refresh-workflow.mjs --write-state --json",
);
assert.equal(
  scripts["okx:current-readiness:refresh:check"],
  "node scripts/check-openclaw-okx-current-readiness-refresh-workflow.mjs",
);

const expectedCommands = [
  "pnpm okx:market-snapshot",
  "pnpm okx:market-snapshot:scheduler",
  "pnpm okx:demo-simulation",
  "pnpm okx:paper-audit-log",
  "pnpm okx:paper-audit-summary",
  "pnpm capital-hft:telegram-trading-shortcuts:check",
  "pnpm okx:current-readiness:check",
];

assert.deepEqual(
  REFRESH_STEPS.map((step) => step.command.join(" ")),
  expectedCommands,
);

const report = await buildOkxCurrentReadinessRefreshWorkflow({ dryRun: true });

assert.equal(report.schema, "openclaw.okx.current-readiness-refresh-workflow.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "planned_read_only_current_readiness_refresh");
assert.equal(report.status, "planned_read_only");
assert.equal(report.code, "okx_current_readiness_refresh_planned");
assert.match(
  report.machineLine,
  /^okxCurrentReadinessRefresh=planned steps=0\/7 freshness=planned schedulerNextRunAt=[^\s]+ noOrderWrite=true$/u,
);
assert.equal(report.reports.currentReadiness.schedulerNextRunAt, report.schedulerNextRunAt);
assert.ok(
  report.markers.includes(
    report.schedulerNextRunAt === "unavailable"
      ? "scheduler_next_run_unavailable"
      : "scheduler_next_run_visible",
  ),
);
assert.deepEqual(report.commands.planned, expectedCommands);
assert.deepEqual(report.commands.executed, []);
assert.deepEqual(report.stepOrder, [
  "market_snapshot",
  "market_snapshot_scheduler",
  "demo_simulation",
  "paper_audit_log",
  "paper_audit_summary",
  "telegram_shortcuts",
  "current_readiness_summary",
]);
assert.equal(report.steps.length, expectedCommands.length);
for (const step of report.steps) {
  assert.equal(step.status, "planned");
  assert.equal(step.exitCode, null);
  assert.match(step.report, /^reports\//u);
}
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.paperOnly, true);
assert.equal(report.safety.demoOnly, true);
assert.equal(report.safety.refreshOnly, true);
assert.equal(report.safety.executionAllowed, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeTradingEnabled, false);
assert.equal(report.safety.orderPlacementEnabled, false);
assert.equal(report.safety.submittedOrder, false);
assert.equal(report.safety.exchangeWriteAttempted, false);
assert.equal(report.safety.orderStatusQueryExecuted, false);
assert.equal(report.safety.cancelOrderEnabled, false);
assert.equal(report.safety.cancelSubmitted, false);
assert.equal(report.safety.withdrawalEnabled, false);
assert.equal(report.safety.noOrderWrite, true);
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.markers.includes("current_readiness_refresh_workflow_planned"));
assert.ok(report.markers.includes("refresh_workflow_dry_run"));
assert.ok(report.markers.includes("read_only_refresh_workflow"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("exchange_write_false"));
assert.ok(report.markers.includes("order_status_query_false"));
assert.ok(report.markers.includes("cancel_submitted_false"));
assert.equal(report.blockers.length, 0);
assert.match(report.summary_zh_tw, /乾跑規劃/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 4);
assert.match(report.nextSafeTask, /Telegram|heartbeat|stale/u);

process.stdout.write(
  [
    "OKX_CURRENT_READINESS_REFRESH_WORKFLOW_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `machineLine=${report.machineLine}`,
    `steps=${report.commands.planned.join(" -> ")}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
