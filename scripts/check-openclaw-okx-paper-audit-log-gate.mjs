import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOkxPaperAuditLogGate } from "./openclaw-okx-paper-audit-log-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:paper-audit-log"],
  "node scripts/openclaw-okx-paper-audit-log-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:paper-audit-log:check"],
  "node scripts/check-openclaw-okx-paper-audit-log-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-paper-audit-log-latest.json",
);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-okx-paper-audit-"));
const tempAuditLogPath = path.join(tempDir, "audit.jsonl");
const appendReport = await buildOkxPaperAuditLogGate({
  auditLogPath: tempAuditLogPath,
  appendAudit: true,
});

const report = await buildOkxPaperAuditLogGate();

assert.equal(report.schema, "openclaw.okx.paper-audit-log-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "append_only_paper_audit_log");
assert.equal(report.status, "ready_append_only");
assert.equal(report.code, "paper_audit_log_ready");
assert.equal(
  report.dependsOn.demoSimulationResultSchema,
  "openclaw.okx.demo-order-simulation-result-gate.v1",
);
assert.equal(report.auditLog.format, "jsonl");
assert.equal(report.auditLog.appended, false);
assert.equal(report.auditLog.bytesWritten, 0);
assert.match(report.auditLog.entryDigest, /^[A-F0-9]{64}$/u);
assert.equal(report.auditLog.entrySchema, "openclaw.okx.paper-audit-entry.v1");
assert.equal(report.auditLog.eventType, "okx.demo_order_simulation_result");
assert.equal(report.latestEntry.schema, "openclaw.okx.paper-audit-entry.v1");
assert.equal(report.latestEntry.eventType, "okx.demo_order_simulation_result");
assert.equal(report.latestEntry.safety.demoOnly, true);
assert.equal(report.latestEntry.safety.readOnly, true);
assert.equal(report.latestEntry.safety.auditOnly, true);
assert.equal(report.latestEntry.safety.submittedOrder, false);
assert.equal(report.latestEntry.safety.exchangeWriteAttempted, false);
assert.equal(report.latestEntry.safety.orderStatusQueryExecuted, false);
assert.equal(report.latestEntry.safety.cancelSubmitted, false);
assert.equal(report.latestEntry.safety.exchangeCancelAttempted, false);
assert.equal(report.safety.paperOnly, true);
assert.equal(report.safety.demoOnly, true);
assert.equal(report.safety.readOnly, true);
assert.equal(report.safety.dryRunOnly, true);
assert.equal(report.safety.auditOnly, true);
assert.equal(report.safety.appendOnly, true);
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
assert.ok(report.commands.executed.includes("okx demo simulation result gate dependency"));
assert.ok(report.commands.notExecuted.includes("GET /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.notExecuted.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/order"));
assert.ok(report.commands.forbidden.includes("POST /api/v5/trade/cancel-order"));
assert.ok(report.markers.includes("append_only_audit"));
assert.ok(report.markers.includes("submitted_order_false"));
assert.ok(report.markers.includes("exchange_write_false"));
assert.ok(report.markers.includes("order_status_query_false"));
assert.ok(report.markers.includes("cancel_submitted_false"));
assert.match(report.summary_zh_tw, /OKX paper audit log/u);
assert.ok(Array.isArray(report.rollbackPath));
assert.ok(report.rollbackPath.length >= 3);
assert.match(report.nextSafeTask, /audit summary|blocker/u);

assert.equal(appendReport.auditLog.appended, true);
assert.ok(appendReport.auditLog.bytesWritten > 0);
assert.match(appendReport.auditLog.entryDigest, /^[A-F0-9]{64}$/u);
const auditText = await fs.readFile(tempAuditLogPath, "utf8");
const auditLines = auditText.trim().split(/\r?\n/u);
assert.equal(auditLines.length, 1);
const auditEntry = JSON.parse(auditLines[0]);
assert.equal(auditEntry.schema, "openclaw.okx.paper-audit-entry.v1");
assert.equal(auditEntry.safety.submittedOrder, false);
assert.equal(auditEntry.safety.exchangeWriteAttempted, false);

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
    "OKX_PAPER_AUDIT_LOG_GATE_CHECK=OK",
    `status=${report.status}`,
    `code=${report.code}`,
    `markers=${report.markers.join("/")}`,
    `blockers=${report.blockers.join("/")}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
