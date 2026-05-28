import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySessionClosedToReportableState,
  classifyReadbackFailure,
  refreshCapitalReportableQuoteState,
  summarizeCallbackStream,
} from "./openclaw-capital-reportable-quote-refresh.mjs";

function pricesAreUsable(quote) {
  return [quote.close, quote.bid, quote.ask].some((value) => Number(value) !== 0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-reportable-refresh-"));
const diagnosisOutput = path.join(tempRoot, "capital-callback-freshness-diagnosis.json");
const reportableOutput = path.join(tempRoot, "capital-reportable-quote-state.json");

const sessionClosedState = applySessionClosedToReportableState(
  {
    schema: "openclaw.capital.reportable-quote-state.v1",
    status: "ready",
    summary: {
      reportableCount: 2,
      blockedCount: 0,
      blockedCategoryCounts: {},
    },
    reportableQuotes: [
      {
        query: "TX00AM",
        symbol: "TX00",
        name: "台指近",
        source: "domestic",
        close: 40078,
        bid: 40078,
        ask: 40079,
        receivedAt: "2026-05-20T13:45:26+08:00",
        timeBasis: "broker_event_time",
        brokerMarketTime: "2026-05-20T13:29:55+08:00",
        ageMs: 1500000,
        maxAgeMs: 45000,
        sourceFile: "capital_quote_events.jsonl",
      },
      {
        query: "CL0000",
        symbol: "CL0000",
        name: "輕原油熱2607",
        source: "overseas",
        close: 103.67,
        bid: 103.66,
        ask: 103.68,
        receivedAt: "2026-05-20T13:55:00+08:00",
        timeBasis: "received_at",
        ageMs: 1000,
        maxAgeMs: 45000,
        sourceFile: "os_symbol_cache.json",
      },
    ],
    blockedQuotes: [],
  },
  {
    quote: {
      status: "session_closed",
      reason: "核心必要商品目前非交易時段：tx-front；不可回舊價，等待開盤 fresh callback。",
    },
  },
);
assert.equal(sessionClosedState.status, "partial_ready");
assert.equal(sessionClosedState.sessionStatus, "session_closed");
assert.equal(sessionClosedState.summary.reportableCount, 1);
assert.equal(sessionClosedState.summary.blockedCount, 1);
assert.equal(sessionClosedState.summary.blockedCategoryCounts.session_closed, 1);
assert.equal(sessionClosedState.reportableQuotes[0].symbol, "CL0000");
assert.equal(sessionClosedState.blockedQuotes[0].symbol, "TX00AM");
assert.equal(sessionClosedState.blockedQuotes[0].blockedCategory, "session_closed");
assert.match(sessionClosedState.blockedQuotes[0].reason, /非交易時段/u);
assert.match(sessionClosedState.nextSafeTask, /不可回舊價/u);

const callbackStream = summarizeCallbackStream(
  {
    reportableQuotes: [],
    blockedQuotes: [
      {
        symbol: "TX00AM",
        source: "domestic",
        blockedCategory: "stale_received_at_with_nonzero_quote",
        lastEvent: {
          stockNo: "TX00AM",
          receivedAt: "2026-05-21T14:46:53+08:00",
          sourceFile: "capital_quote_events.jsonl",
        },
      },
      {
        symbol: "CN0000",
        source: "overseas",
        blockedCategory: "stale_received_at_with_nonzero_quote",
        lastEvent: {
          stockNo: "CN0000",
          receivedAt: "2026-05-21T14:49:12+08:00",
          sourceFile: "os_latest_quote_event.json",
        },
      },
    ],
  },
  Date.parse("2026-05-21T15:00:00+08:00"),
);
assert.equal(callbackStream.state, "stale_callbacks_only");
assert.equal(callbackStream.latestEventSymbol, "CN0000");
assert.equal(callbackStream.staleSymbolCount, 2);
assert.equal(callbackStream.missingSymbolCount, 0);
assert.equal(callbackStream.sourceFileCounts["capital_quote_events.jsonl"], 1);
assert.equal(callbackStream.sourceFileCounts["os_latest_quote_event.json"], 1);

const missingLauncherFailure = classifyReadbackFailure({
  stderr:
    "Error: ENOENT: no such file or directory, open 'D:\\群益及元大API\\CapitalHftService\\啟動策略交易-真實.bat'",
});
assert.equal(missingLauncherFailure.blockerCode, "subscription_guard_launcher_missing");
assert.deepEqual(missingLauncherFailure.failedSteps, [
  "callback_readback",
  "subscription_guard_check",
]);
assert.equal(missingLauncherFailure.failureCategory, "missing_required_launcher_file");
assert.match(missingLauncherFailure.missingFile, /啟動策略交易-真實\.bat/u);
assert.match(missingLauncherFailure.recommendedAction, /不可用舊報價/u);

const report = await refreshCapitalReportableQuoteState({
  repoRoot: process.cwd(),
  writeState: true,
  diagnosisOutput,
  reportableOutput,
  maxAgeMs: 45000,
});

assert.equal(report.schema, "openclaw.capital.reportable-quote-refresh.v1");
assert.equal(report.readOnly, true);
assert.equal(report.liveTradingEnabled, false);
assert.equal(report.writeTradingEnabled, false);
assert.equal(report.sentOrder, false);
assert.equal(report.sentSubscribeCommand, false);
if (report.blockerCode === "subscription_guard_launcher_missing") {
  assert.equal(report.status, "blocked");
  assert.equal(report.steps.readback.ok, false);
  assert.ok(report.failedSteps.includes("subscription_guard_check"));
  assert.match(report.missingFile, /啟動策略交易-真實\.bat/u);
} else {
  assert.equal(report.steps.readback.ok, true);
  assert.equal(report.steps.diagnosis.ok, true);
  assert.equal(report.steps.reportable.ok, true);
  assert.equal(report.steps.reportable.outputPath, reportableOutput);
  assert.ok(Array.isArray(report.reportableQuotes));
  assert.ok(Array.isArray(report.blockedQuotes));
  assert.ok(report.callbackStream && typeof report.callbackStream === "object");
  assert.ok(typeof report.callbackStream.state === "string");
  await fs.access(reportableOutput);
  await fs.access(`${reportableOutput}.sha256`);
}
if ((report.reportableQuotes ?? []).length === 0) {
  assert.ok(
    report.blockerCode === "callback_stream_stale_or_missing" ||
      report.blockerCode === "no_fresh_matched_reportable_quote" ||
      report.blockerCode === "capital_hft_service_dead_pid" ||
      report.blockerCode === "capital_hft_service_status_stale" ||
      report.blockerCode === "capital_hft_service_status_missing" ||
      report.blockerCode === "capital_hft_service_pid_missing" ||
      report.blockerCode === "subscription_guard_launcher_missing",
    `unexpected blockerCode ${report.blockerCode}`,
  );
  assert.ok(
    report.blockerCode !== "subscription_guard_launcher_missing" ||
      (Array.isArray(report.failedSteps) &&
        report.failedSteps.includes("subscription_guard_check")),
    `unexpected blockerCode ${report.blockerCode}`,
  );
}
if (
  (report.reportableQuotes ?? []).length === 0 &&
  report.blockerCode !== "subscription_guard_launcher_missing"
) {
  assert.ok(Array.isArray(report.failedSteps), "blocked report must include failedSteps");
  assert.ok(report.failedSteps.length > 0, "blocked report failedSteps must not be empty");
  assert.ok(
    report.serviceLiveness && typeof report.serviceLiveness === "object",
    "blocked report must include serviceLiveness",
  );
}
for (const quote of report.reportableQuotes ?? []) {
  assert.ok(pricesAreUsable(quote), `${quote.symbol} must not be reportable with all zero prices`);
  assert.ok(Number(quote.ageMs) <= Number(quote.maxAgeMs), `${quote.symbol} must not be stale`);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      reportableCount: (report.reportableQuotes ?? []).length,
      blockedCount: (report.blockedQuotes ?? []).length,
      blockerCode: report.blockerCode,
    },
    null,
    2,
  ),
);
