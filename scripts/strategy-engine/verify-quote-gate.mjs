#!/usr/bin/env node
/**
 * verify-quote-gate.mjs — 驗證 fresh quote gate 是否通過
 * 用法: node verify-quote-gate.mjs
 */
const BASE = process.env.CAPITAL_HFT_URL ?? "http://localhost:8765";

async function main() {
  const report = { schema: "openclaw.quote-gate-verify.v1", generatedAt: new Date().toISOString() };

  // 1. 基礎連線
  let status;
  try {
    const res = await fetch(`${BASE}/api/status`);
    status = await res.json();
  } catch (e) {
    report.status = "blocked";
    report.reason = "http_unreachable";
    report.error = e.message;
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  report.login = status.loginStatus;
  report.certificate = status.certificateLoaded;
  report.quoteMonitor = status.quoteMonitorConnected;
  report.osQuote = status.osQuoteConnected;
  report.orderInit = status.orderInitialized;

  // 2. 基礎 gate
  const baseOk =
    status.loginStatus === "connected" &&
    status.certificateLoaded === true &&
    status.quoteMonitorConnected === true;
  report.baseGate = baseOk ? "passed" : "blocked";

  // 3. 報價 freshness（用 quoteStats）
  report.domesticQuotes = {
    quoteCount: status.quoteStats?.quoteCount ?? 0,
    tickCount: status.quoteStats?.tickCount ?? 0,
    lastAt: status.quoteStats?.lastQuoteAt ?? null,
  };
  report.overseasQuotes = {
    quoteCount: status.osQuoteStats?.quoteCount ?? 0,
    tickCount: status.osQuoteStats?.tickCount ?? 0,
    lastAt: status.osQuoteStats?.lastQuoteAt ?? null,
  };

  // 4. freshness 判斷
  const now = Date.now();
  const domesticAge = status.quoteStats?.lastQuoteAt
    ? now - new Date(status.quoteStats.lastQuoteAt).getTime()
    : Infinity;
  const overseasAge = status.osQuoteStats?.lastQuoteAt
    ? now - new Date(status.osQuoteStats.lastQuoteAt).getTime()
    : Infinity;

  report.domesticFresh = domesticAge < 300_000; // < 5 分鐘
  report.overseasFresh = overseasAge < 300_000;

  // 5. 總結
  const quotesOk = report.domesticQuotes.tickCount > 0 || report.overseasQuotes.tickCount > 0;
  const freshOk = report.domesticFresh || report.overseasFresh;

  if (baseOk && quotesOk && freshOk) {
    report.status = "ready";
    report.reason = "all_gates_passed";
  } else if (baseOk && quotesOk && !freshOk) {
    report.status = "stale";
    report.reason = "quotes_exist_but_stale";
    report.domesticAgeMs = domesticAge;
    report.overseasAgeMs = overseasAge;
  } else if (baseOk && !quotesOk) {
    report.status = "blocked";
    report.reason = "no_tick_data";
  } else {
    report.status = "blocked";
    report.reason = "base_gate_failed";
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === "ready" ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
