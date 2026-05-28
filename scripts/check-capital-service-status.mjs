import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readCapitalServiceStatus,
  writeCapitalServiceStatus,
} from "./openclaw-capital-service-status.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};
assert.equal(
  scripts["capital:service-status"],
  "node scripts/openclaw-capital-service-status.mjs --write-state --json",
);
assert.equal(
  scripts["capital:service-status:check"],
  "node scripts/check-capital-service-status.mjs",
);

const report = await readCapitalServiceStatus({ repoRoot });

assert.equal(report.schema, "openclaw.capital.service-status.v1");
assert.equal(report.readOnly, true);
assert.equal(report.liveTradingEnabled, false);
assert.equal(report.writeTradingEnabled, false);
assert.equal(typeof report.blockerCode, "string");
assert.equal(Array.isArray(report.failedSteps), true);
if (report.ready) {
  assert.equal(report.blockerCode, "");
  assert.equal(report.failedSteps.length, 0);
} else {
  assert.notEqual(report.blockerCode, "");
  assert.notEqual(report.failedSteps.length, 0);
}
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.realOrderAllowed, false);
assert.equal(typeof report.riskControlsObserved, "object");
assert.equal(typeof report.riskControlsObserved.allowLiveTrading, "boolean");
assert.equal(typeof report.riskControlsObserved.writeBrokerOrders, "boolean");
assert.equal(report.riskControlsObserved.reportOnly, true);
assert.equal(typeof report.service, "object");
assert.equal(typeof report.service.pidAlive, "boolean");
assert.equal(typeof report.service.ready, "boolean");
assert.equal(typeof report.service.livenessStatus, "string");
assert.match(
  report.service.livenessStatus,
  /^(alive|dead_pid|stale_status|missing_status|missing_pid)$/u,
);
assert.equal(typeof report.service.statusFresh, "boolean");
assert.equal(typeof report.recovery, "object");
assert.equal(report.recovery.mode, "operator_paper_only_restart");
assert.equal(typeof report.recovery.launcherPath, "string");
assert.equal(typeof report.recovery.launcherExists, "boolean");
assert.equal(report.recovery.autoExecutedByOpenClaw, false);
assert.equal(report.recovery.requiresOperator, true);
assert.equal(report.recovery.safety.paperOnly, true);
assert.equal(report.recovery.safety.liveTradingEnabled, false);
assert.equal(report.recovery.safety.writeBrokerOrders, false);
assert.equal(report.recovery.safety.sentOrder, false);
assert.equal(report.recovery.safety.telegramPolling, false);
assert.deepEqual(report.recovery.validationCommands, [
  "pnpm capital:service-status:check",
  "pnpm capital:quote:status:check",
]);
if (report.service.livenessStatus === "alive") {
  assert.equal(report.service.ready, true);
  assert.equal(report.recovery.required, false);
} else {
  assert.equal(report.service.ready, false);
  assert.equal(report.ready, false);
  assert.equal(report.recovery.required, true);
  assert.equal(report.recovery.reason, report.service.livenessStatus);
}
const watchdogMarketClosed =
  report.watchdog?.status === "blocked" && report.watchdog?.blockerCode === "market_session_closed";
if (watchdogMarketClosed) {
  assert.equal(report.watchdog.ready, false);
  assert.equal(report.ready, false);
  assert.match(
    report.blockerCode,
    /^(market_session_closed|capital_watchdog_not_ready|capital_hft_service_dead_pid|capital_hft_service_status_stale|capital_hft_service_status_missing|capital_hft_service_pid_missing)$/u,
  );
  assert.match(
    report.nextSafeTask,
    /等待國內期貨交易時段恢復|等待下一交易時段|不可回舊價|先修復 blocked_or_degraded|重啟 CapitalHftService/u,
  );
} else {
  assert.equal(report.watchdog.status, "healthy");
}
assert.equal(report.quote.strictGateSource, "capital_core_product_freshness_matrix");
assert.equal(report.quote.legacyStrictGateSource, "capital_quote_status");
assert.equal(typeof report.quote.freshnessStatus, "string");
assert.equal(typeof report.quote.matrixSummary, "object");
if (report.quote.freshnessStatus === "fresh") {
  assert.equal(report.quote.ready, true);
  assert.match(report.replyLine, /報價=READY/u);
  assert.equal(report.safety.staleQuoteReturned, false);
} else if (report.quote.freshnessStatus === "session_closed") {
  assert.equal(report.quote.ready, false);
  assert.equal(report.safety.staleQuoteReturned, true);
  assert.match(report.replyLine, /報價=SESSION_CLOSED/u);
  assert.doesNotMatch(report.replyLine, /報價=BLOCKED/u);
  assert.match(report.nextSafeTask, /等待國內期貨交易時段恢復|重啟 CapitalHftService/u);
} else {
  assert.equal(report.quote.ready, false);
  assert.equal(report.safety.staleQuoteReturned, true);
  assert.match(report.replyLine, /報價=BLOCKED/u);
  assert.match(report.nextSafeTask, /quote freshness/u);
  assert.doesNotMatch(report.nextSafeTask, /capability\/watchdog\/orderMode/u);
}
assert.equal(report.positionQuery.ready, true);
assert.equal(report.paperTrading.ready, true);
assert.equal(report.orderMode.status, "pass");
assert.equal(report.orderMode.summary, "國內當沖/國內非當沖/海外當沖/海外非當沖:READY");
assert.equal(typeof report.telegramPoller, "object");
assert.equal(typeof report.telegramPoller.summary, "string");
assert.match(
  report.telegramPoller.summary,
  /^(READY|missing|disabled|send-only:|stopped|衝突:duplicate_poller_detected|衝突:capital_polling_enabled:|ERROR:|unknown)/u,
);
if (report.telegramPoller.available) {
  assert.equal(report.telegramPoller.pollingEnabled, false);
  assert.equal(report.telegramPoller.pollingOwner, "openclaw_gateway");
  assert.equal(report.telegramPoller.duplicatePollerDetected, false);
  assert.match(report.telegramPoller.summary, /^(send-only:openclaw_gateway|disabled)$/u);
}
assert.match(report.replyLine, /OpenClaw Capital 狀態/u);
assert.match(report.replyLine, /查詢=READY/u);
assert.match(report.replyLine, /模擬=READY/u);
assert.match(report.replyLine, /真單=封鎖/u);
assert.match(report.replyLine, /服務=/u);
assert.match(report.replyLine, /下單模式=國內當沖\/國內非當沖\/海外當沖\/海外非當沖:READY/u);
assert.match(report.replyLine, /Telegram=/u);
assert.match(report.replyLine, /未送單/u);

const forcedDeadPidReport = await readCapitalServiceStatus({
  repoRoot,
  serviceStatusFreshSeconds: Number.MAX_SAFE_INTEGER,
  pidExists: async () => false,
});
if (forcedDeadPidReport.service.pid !== null && forcedDeadPidReport.service.statusGeneratedAt) {
  assert.equal(forcedDeadPidReport.service.livenessStatus, "dead_pid");
  assert.equal(forcedDeadPidReport.service.ready, false);
  assert.equal(forcedDeadPidReport.ready, false);
  assert.equal(forcedDeadPidReport.blockerCode, "capital_hft_service_dead_pid");
  assert.equal(forcedDeadPidReport.failedSteps.includes("service_liveness:dead_pid"), true);
  assert.match(forcedDeadPidReport.nextSafeTask, /重啟 CapitalHftService/u);
  assert.equal(forcedDeadPidReport.recovery.required, true);
  assert.equal(forcedDeadPidReport.recovery.reason, "dead_pid");
  assert.match(forcedDeadPidReport.recovery.command, /run-capital-hft-service-persistent\.ps1/u);
  assert.match(forcedDeadPidReport.recovery.command, /-Start/u);
  assert.match(forcedDeadPidReport.recovery.command, /-Json/u);
}

const outputs = await writeCapitalServiceStatus(report, { repoRoot });
await fs.access(outputs.panelPath);
await fs.access(`${outputs.panelPath}.sha256`);
await fs.access(outputs.reportPath);
await fs.access(`${outputs.reportPath}.sha256`);

const panel = JSON.parse(await fs.readFile(outputs.panelPath, "utf8"));
assert.equal(panel.schema, report.schema);
assert.equal(panel.replyLine, report.replyLine);

if (!path.resolve(outputs.panelPath).includes(`${path.sep}.openclaw${path.sep}quote${path.sep}`)) {
  throw new Error(`panel path is not under .openclaw/quote: ${outputs.panelPath}`);
}

const cliBlocked = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "openclaw-capital-service-status.mjs"),
    "--repo-root",
    repoRoot,
    "--capital-root",
    path.join(os.tmpdir(), "openclaw-capital-service-status-missing"),
    "--json",
  ],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(cliBlocked.status, 0);
assert.match(cliBlocked.stdout, /"status": "blocked_or_degraded"/u);

const cliStrictBlocked = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "openclaw-capital-service-status.mjs"),
    "--repo-root",
    repoRoot,
    "--capital-root",
    path.join(os.tmpdir(), "openclaw-capital-service-status-missing"),
    "--json",
    "--strict-exit",
  ],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(cliStrictBlocked.status, 2);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "PASS",
      serviceStatus: report.status,
      ready: report.ready,
      blockerCode: report.blockerCode,
      failedSteps: report.failedSteps,
      pidAlive: report.service.pidAlive,
      livenessStatus: report.service.livenessStatus,
      statusFresh: report.service.statusFresh,
      statusAgeSeconds: report.service.statusAgeSeconds,
      quoteStatus: report.quote.status,
      quoteReason: report.quote.reason,
    },
    null,
    2,
  )}\n`,
);
