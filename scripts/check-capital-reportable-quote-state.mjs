import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCapitalReportableQuoteState,
  writeCapitalReportableQuoteState,
} from "./openclaw-capital-reportable-quote-state.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-reportable-quote-"));
const diagnosisPath = path.join(tempRoot, "capital-callback-freshness-diagnosis.json");
const outputPath = path.join(tempRoot, "capital-reportable-quote-state.json");
const freshIso = new Date(Date.now() - 1000).toISOString();

await fs.writeFile(
  diagnosisPath,
  JSON.stringify(
    {
      schema: "openclaw.capital.callback-freshness-diagnosis.v1",
      marketDiagnostics: {
        domesticReportable: [
          {
            symbol: "TX00AM",
            source: "domestic",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "TX00",
              stockName: "台指近",
              close: 40174,
              bid: 40174,
              ask: 40175,
              receivedAt: freshIso,
              timeBasis: "broker_event_time",
              brokerMarketTime: freshIso,
              sourceFile: "capital_quote_events.jsonl",
            },
            maxAgeMs: 3600000,
          },
        ],
        domesticBlocked: [
          {
            symbol: "XE0000AM",
            source: "domestic",
            reportable: false,
            freshMatched: false,
            diagnosis: "zero_price_callback",
            blockedCategory: "zero_price_callback",
            reason: "callback_stale_during_open_session",
            unblockCondition:
              "broker callback returns non-zero bid/ask/close within the freshness threshold.",
            recommendedAction:
              "do not report; verify product code, entitlement, or exclude this symbol until non-zero callbacks appear.",
            lastEvent: {
              stockNo: "XE0000AM",
              stockName: "歐元近",
              close: 0,
              bid: 0,
              ask: 0,
              receivedAt: "2026-05-20T02:42:23+08:00",
              sourceFile: "capital_quote_events.jsonl",
            },
          },
        ],
        overseasReportable: [
          {
            symbol: "CN0000",
            source: "overseas",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "CN0000",
              stockName: "A50指熱2605",
              close: 15445,
              bid: 15444,
              ask: 15446,
              receivedAt: freshIso,
              timeBasis: "received_at",
              sourceFile: "os_symbol_cache.json",
            },
            maxAgeMs: 3600000,
          },
          {
            symbol: "CN0000",
            source: "overseas",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "CN0000",
              stockName: "A50指熱2605",
              close: 15445,
              bid: 15444,
              ask: 15446,
              receivedAt: freshIso,
              timeBasis: "received_at",
              sourceFile: "os_symbol_cache.json",
            },
          },
          {
            symbol: "YM0000",
            source: "overseas",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "YM0000",
              stockName: "道瓊迷你",
              close: 44210,
              bid: 44209,
              ask: 44211,
              receivedAt: freshIso,
              timeBasis: "received_at",
              sourceFile: "os_symbol_cache.json",
            },
            maxAgeMs: 3600000,
          },
          {
            symbol: "ES0000",
            source: "overseas",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "ES0000",
              stockName: "小道指",
              close: 5178.25,
              bid: 5178.0,
              ask: 5178.25,
              receivedAt: freshIso,
              timeBasis: "received_at",
              sourceFile: "os_symbol_cache.json",
            },
            maxAgeMs: 3600000,
          },
          {
            symbol: "NQ0000",
            source: "overseas",
            reportable: true,
            freshMatched: true,
            lastEvent: {
              stockNo: "NQ0000",
              stockName: "那斯達克小型",
              close: 18244.5,
              bid: 18244.25,
              ask: 18244.5,
              receivedAt: freshIso,
              timeBasis: "received_at",
              sourceFile: "os_symbol_cache.json",
            },
            maxAgeMs: 3600000,
          },
        ],
        overseasBlocked: [],
      },
      summary: {
        domestic: { blockedCategoryCounts: { zero_price_callback: 1 } },
        overseas: { blockedCategoryCounts: { zero_price_callback: 1 } },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const state = await buildCapitalReportableQuoteState({ diagnosis: diagnosisPath });

if (state.schema !== "openclaw.capital.reportable-quote-state.v1") {
  throw new Error(`unexpected schema ${state.schema}`);
}
if (
  !state.readOnly ||
  state.loginAttempted ||
  state.liveTradingEnabled ||
  state.writeTradingEnabled ||
  state.sentOrder
) {
  throw new Error("reportable quote state must be read-only/no-login/no-trading");
}
if (state.status !== "partial_ready") {
  throw new Error(`expected partial_ready, got ${state.status}`);
}
if (state.summary.reportableCount !== 5 || state.summary.blockedCount !== 1) {
  throw new Error(`unexpected summary ${JSON.stringify(state.summary)}`);
}
if (state.summary.blockedCategoryCounts?.zero_price_callback !== 2) {
  throw new Error(
    `expected merged blocked category count, got ${JSON.stringify(state.summary.blockedCategoryCounts)}`,
  );
}
if (!state.reportableQuotes.some((quote) => quote.symbol === "TX00" && quote.close === 40174)) {
  throw new Error(`missing TX00 reportable quote ${JSON.stringify(state.reportableQuotes)}`);
}
if (state.reportableQuotes.filter((quote) => quote.symbol === "CN0000").length !== 1) {
  throw new Error(`expected deduped CN0000 quote ${JSON.stringify(state.reportableQuotes)}`);
}
if (!state.reportableQuotes.some((quote) => quote.symbol === "YM0000" && quote.close === 44210)) {
  throw new Error(`missing YM0000 reportable quote ${JSON.stringify(state.reportableQuotes)}`);
}
if (!state.reportableQuotes.some((quote) => quote.symbol === "ES0000" && quote.close === 5178.25)) {
  throw new Error(`missing ES0000 reportable quote ${JSON.stringify(state.reportableQuotes)}`);
}
if (!state.reportableQuotes.some((quote) => quote.symbol === "NQ0000" && quote.close === 18244.5)) {
  throw new Error(`missing NQ0000 reportable quote ${JSON.stringify(state.reportableQuotes)}`);
}
if (
  !state.blockedQuotes.some(
    (quote) => quote.symbol === "XE0000AM" && quote.blockedCategory === "zero_price_callback",
  )
) {
  throw new Error(`missing XE0000AM blocked quote ${JSON.stringify(state.blockedQuotes)}`);
}

await writeCapitalReportableQuoteState(state, outputPath);
await fs.access(outputPath);
await fs.access(`${outputPath}.sha256`);

process.stdout.write("CAPITAL_REPORTABLE_QUOTE_STATE_CHECK=OK\n");
