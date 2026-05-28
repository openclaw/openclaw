import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOkxPaperAuditSummaryGate } from "./openclaw-okx-paper-audit-summary-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:paper-audit-summary"],
  "node scripts/openclaw-okx-paper-audit-summary-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:paper-audit-summary:check"],
  "node scripts/check-openclaw-okx-paper-audit-summary-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-paper-audit-summary-latest.json",
);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-okx-paper-audit-summary-"));
const tempAuditLogPath = path.join(tempDir, "audit.jsonl");
const fixtureEntry = {
  schema: "openclaw.okx.paper-audit-entry.v1",
  ts: new Date(0).toISOString(),
  provider: "okx",
  eventType: "okx.demo_order_simulation_result",
  sourceReport:
    "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
  sourceDigest: "A".repeat(64),
  status: "ready_no_exchange_write",
  code: "demo_order_simulation_result_ready",
  result: {
    profile: "demo",
    instId: "BTC-USDT",
    simulationCode: "demo_simulation_no_exchange_write",
    simulationStatus: "simulation_ready_no_submission",
    simulatedClientOrderId: "openclaw-okx-demo-sim-test",
    exchangeOrderId: "",
    orderStatus: "simulated_not_submitted",
    fillStatus: "not_applicable",
    cancelStatus: "not_applicable",
  },
  safety: {
    demoOnly: true,
    readOnly: true,
    dryRunOnly: true,
    auditOnly: true,
    submittedOrder: false,
    exchangeWriteAttempted: false,
    orderStatusQueryExecuted: false,
    cancelSubmitted: false,
    exchangeCancelAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    credentialEchoed: false,
    storesSecretsInRepo: false,
  },
};
await fs.writeFile(tempAuditLogPath, `${JSON.stringify(fixtureEntry)}\n`, "utf8");

const fixtureReport = await buildOkxPaperAuditSummaryGate({ auditLogPath: tempAuditLogPath });
assert.equal(fixtureReport.status, "ready_read_only");
assert.equal(fixtureReport.auditLog.parsedEntries, 1);
assert.equal(fixtureReport.auditLog.invalidLineCount, 0);
assert.equal(fixtureReport.counts.totalEntries, 1);
assert.equal(fixtureReport.safetyAggregate.allEntriesSafe, true);
assert.equal(fixtureReport.safetyAggregate.submittedOrder, 0);
assert.equal(fixtureReport.safetyAggregate.exchangeWriteAttempted, 0);
assert.equal(fixtureReport.safetyAggregate.orderStatusQueryExecuted, 0);
assert.equal(fixtureReport.safetyAggregate.cancelSubmitted, 0);
assert.equal(fixtureReport.latestEntry.result.instId, "BTC-USDT");

const report = await buildOkxPaperAuditSummaryGate();
assert.equal(report.schema, "openclaw.okx.paper-audit-summary-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "read_only_paper_audit_summary");
assert.equal(report.status, "ready_read_only");
assert.equal(report.code, "paper_audit_summary_ready");
assert.equal(report.auditLog.format, "jsonl");
assert.equal(report.auditLog.exists, true);
assert.match(report.auditLog.rawDigest, /^[A-F0-9]{64}$/u);
assert.ok(report.auditLog.lineCount >= 1);
assert.ok(report.auditLog.parsedEntries >= 1);
assert.equal(report.auditLog.invalidLineCount, 0);
assert.equal(report.counts.totalEntries, report.auditLog.parsedEntries);
assert.ok(report.counts.byEventType["okx.demo_order_simulation_result"] >= 1);
assert.ok(report.counts.byStatus.ready_no_exchange_write >= 1);
assert.ok(report.counts.byCode.demo_order_simulation_result_ready >= 1);
assert.ok(report.latestEntry);
assert.equal(report.latestEntry.provider, "okx");
assert.equal(report.latestEntry.eventType, "okx.demo_order_simulation_result");
assert.equal(report.latestEntry.result.exchangeOrderId, "");
assert.equal(report.safetyAggregate.submittedOrder, 0);
assert.equal(report.safetyAggregate.exchangeWriteAttempted, 0);
assert.equal(report.safetyAggregate.orderStatusQueryExecuted, 0);
assert.equal(report.safetyAggregate.cancelSubmitted, 0);
assert.equal(report.safetyAggregate.exchangeCancelAttempted, 0);
assert.equal(report.safetyAggregate.liveTradingEnabled, 0);
assert.equal(report.safetyAggregate.writeTradingEnabled, 0);
assert.equal(report.safetyAggregate.credentialEchoed, 0);
assert.equal(report.safetyAggregate.storesSecretsInRepo, 0);
assert.equal(report.safetyAggregate.allEntriesSafe, true);
assert.equal(report.safety.paperOnly, true);
assert.equal(report.safety.demoOnly, true);
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.auditOnly, true);
assert.equal(report.safety.summaryOnly, true);
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
assert.ok(report.commands.executed.includes("read local OpenClaw OKX paper audit JSONL"));
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.markers.includes("read_only_audit_summary"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("exchange_write_false"));
assert.ok(report.markers.includes("order_status_query_false"));
assert.ok(report.markers.includes("cancel_submitted_false"));
assert.match(report.summary_zh_tw, /OKX paper audit summary/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /assistant status|blocker/u);

await fs.rm(tempDir, { recursive: true, force: true });

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
    "OKX_PAPER_AUDIT_SUMMARY_GATE_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `entries=${report.counts.totalEntries}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
