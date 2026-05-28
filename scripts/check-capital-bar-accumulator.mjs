import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBarsFromTicks,
  buildDailySummary,
  runBarAccumulator,
} from "./openclaw-capital-bar-accumulator.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const baseTs = "2026-05-21T01:00:01.000Z"; // 09:00 TWT
const lines = [
  {
    stockNo: "TX00",
    receivedAt: baseTs,
    eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
    close: "4234000",
    bid: "4233900",
    ask: "4234300",
    qty: "2",
    decimal: "2",
    rawSummary: "stockNo=TX00 close=4234000 bid=4233900 ask=4234300 qty=2 decimal=2 sim=0",
  },
  {
    stockNo: "TX00",
    receivedAt: "2026-05-21T01:00:45.000Z",
    eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
    close: "4234300",
    bid: "4234100",
    ask: "4234500",
    qty: "3",
    decimal: "2",
    rawSummary: "stockNo=TX00 close=4234300 bid=4234100 ask=4234500 qty=3 decimal=2 sim=0",
  },
  {
    stockNo: "TX00",
    receivedAt: "2026-05-21T01:01:10.000Z",
    eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
    close: "4233800",
    bid: "4233600",
    ask: "4234000",
    qty: "1",
    decimal: "2",
    rawSummary: "stockNo=TX00 close=4233800 bid=4233600 ask=4234000 qty=1 decimal=2 sim=0",
  },
].map((event) => JSON.stringify(event));

const bars = buildBarsFromTicks(lines, "TX00", 1);
if (bars.length !== 2) {
  throw new Error(`expected 2 minute bars, got ${bars.length}`);
}
if (bars[0].symbol !== "TX00" || bars[0].open !== 42340 || bars[0].close !== 42343) {
  throw new Error(`first bar normalization failed: ${JSON.stringify(bars[0])}`);
}
if (bars[0].volume !== 5 || bars[1].volume !== 1) {
  throw new Error(`bar volume aggregation failed: ${JSON.stringify(bars)}`);
}

const summary = buildDailySummary("TX00", "2026-05-21", bars);
if (!summary || summary.open !== 42340 || summary.close !== 42338 || summary.bars !== 2) {
  throw new Error(`daily summary failed: ${JSON.stringify(summary)}`);
}

const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-bar-"));
const ticksPath = path.join(repoRoot, "capital_quote_events.jsonl");
const barsPath = path.join(repoRoot, "bars", "TX00-1min-bars.jsonl");
const dailyPath = path.join(repoRoot, "bars", "TX00-daily-summary.jsonl");
await fs.writeFile(ticksPath, `${lines.join("\n")}\n`, "utf8");

const result = await runBarAccumulator({
  repoRoot,
  symbol: "TX00",
  resolveSymbol: false,
  ticksPath,
  barsPath,
  dailyPath,
});

if (result.status !== "ok") {
  throw new Error(`runBarAccumulator status should be ok: ${result.status}`);
}
if (result.symbol !== "TX00") {
  throw new Error(`fallback symbol must be TX00, got ${result.symbol}`);
}
if (String(result.symbol).includes("AM") || String(result.barsPath).includes("TX00AM")) {
  throw new Error(`wrong domestic symbol leaked into output: ${JSON.stringify(result)}`);
}
if (!(await exists(barsPath)) || !(await exists(dailyPath))) {
  throw new Error("bar accumulator did not write expected temp output files");
}

const previousStateDir = process.env.CAPITAL_HFT_STATE_DIR;
process.env.CAPITAL_HFT_STATE_DIR = repoRoot;
const resolverFallbackBarsPath = path.join(repoRoot, "bars", "TX00-resolver-1min-bars.jsonl");
const resolverFallbackDailyPath = path.join(repoRoot, "bars", "TX00-resolver-daily-summary.jsonl");
const resolverFallback = await runBarAccumulator({
  repoRoot,
  symbol: "tx-front",
  ticksPath,
  barsPath: resolverFallbackBarsPath,
  dailyPath: resolverFallbackDailyPath,
});
if (previousStateDir === undefined) {
  delete process.env.CAPITAL_HFT_STATE_DIR;
} else {
  process.env.CAPITAL_HFT_STATE_DIR = previousStateDir;
}

if (resolverFallback.status !== "ok_historical_snapshot") {
  throw new Error(
    `休市/過期 resolver 應允許 historical snapshot 聚合，實際狀態: ${resolverFallback.status}`,
  );
}
if (resolverFallback.resolverReady !== false || resolverFallback.historicalFallbackUsed !== true) {
  throw new Error(
    `snapshot fallback 欄位錯誤: ${JSON.stringify({
      resolverReady: resolverFallback.resolverReady,
      historicalFallbackUsed: resolverFallback.historicalFallbackUsed,
    })}`,
  );
}
if (resolverFallback.symbol !== "TX00" || String(resolverFallback.symbol).includes("AM")) {
  throw new Error(
    `resolver fallback 必須使用 TX00 且不得使用 legacy alias: ${resolverFallback.symbol}`,
  );
}
if (
  resolverFallback.readOnly !== true ||
  resolverFallback.liveTradingEnabled !== false ||
  resolverFallback.writeTradingEnabled !== false ||
  resolverFallback.brokerOrderPathEnabled !== false
) {
  throw new Error(
    `安全欄位錯誤: ${JSON.stringify({
      readOnly: resolverFallback.readOnly,
      liveTradingEnabled: resolverFallback.liveTradingEnabled,
      writeTradingEnabled: resolverFallback.writeTradingEnabled,
      brokerOrderPathEnabled: resolverFallback.brokerOrderPathEnabled,
    })}`,
  );
}

await fs.writeFile(path.join(repoRoot, "hft_service_status.json"), "", "utf8");
process.env.CAPITAL_HFT_STATE_DIR = repoRoot;
const resolverErrorFallback = await runBarAccumulator({
  repoRoot,
  symbol: "tx-front",
  ticksPath,
  barsPath: path.join(repoRoot, "bars", "TX00-resolver-error-1min-bars.jsonl"),
  dailyPath: path.join(repoRoot, "bars", "TX00-resolver-error-daily-summary.jsonl"),
});
if (previousStateDir === undefined) {
  delete process.env.CAPITAL_HFT_STATE_DIR;
} else {
  process.env.CAPITAL_HFT_STATE_DIR = previousStateDir;
}
if (
  resolverErrorFallback.status !== "ok_historical_snapshot" ||
  resolverErrorFallback.resolver?.status !== "resolver_error"
) {
  throw new Error(
    `resolver invalid JSON fallback 失敗: ${JSON.stringify({
      status: resolverErrorFallback.status,
      resolverStatus: resolverErrorFallback.resolver?.status,
    })}`,
  );
}
if (resolverErrorFallback.symbol !== "TX00") {
  throw new Error(`resolver error fallback 必須落到 TX00，實際: ${resolverErrorFallback.symbol}`);
}

const blockedLegacyBarsPath = path.join(repoRoot, "bars", "TX00AM-blocked-1min-bars.jsonl");
const blockedLegacyDailyPath = path.join(repoRoot, "bars", "TX00AM-blocked-daily-summary.jsonl");
const blockedLegacyAlias = await runBarAccumulator({
  repoRoot,
  symbol: "TX00AM",
  ticksPath,
  barsPath: blockedLegacyBarsPath,
  dailyPath: blockedLegacyDailyPath,
});
if (
  blockedLegacyAlias.status !== "blocked_symbol_not_ready" ||
  blockedLegacyAlias.resolver?.status !== "invalid_legacy_session_alias"
) {
  throw new Error(
    `TX00AM 必須被 strategy bar accumulator 阻擋: ${JSON.stringify(blockedLegacyAlias)}`,
  );
}
if (blockedLegacyAlias.symbol === "TX00AM" || blockedLegacyAlias.symbol === "TX06AM") {
  throw new Error(
    `blocked legacy alias 不得成為 active symbol: ${JSON.stringify(blockedLegacyAlias)}`,
  );
}
if ((await exists(blockedLegacyBarsPath)) || (await exists(blockedLegacyDailyPath))) {
  throw new Error("blocked legacy alias must not create bar output files");
}

process.stdout.write("CAPITAL_BAR_ACCUMULATOR_CHECK=OK symbol=TX00 bars=2 daily=1\n");
