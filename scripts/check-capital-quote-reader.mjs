import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCapitalQuoteState, writeCapitalQuoteState } from "./openclaw-capital-quote-reader.mjs";

function pad(value, size = 2) {
  return String(value).padStart(size, "0");
}

function capitalHftTimestamp(date, ageSeconds = 0) {
  const shifted = new Date(date.getTime() - ageSeconds * 1000);
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())} ${pad(
    shifted.getHours(),
  )}:${pad(shifted.getMinutes())}:${pad(shifted.getSeconds())}.${pad(
    shifted.getMilliseconds(),
    3,
  )}`;
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-quote-reader-"));
const stateDir = path.join(tempRoot, "CapitalHftService", "state");
const repoRoot = path.join(tempRoot, "repo");
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(repoRoot, { recursive: true });

const bridge = {
  schema: "capital-hft.openclaw.quote-bridge.v1",
  status: "connected",
  overallReady: true,
  quoteUniverseCount: 18404,
  currentBlockingCode: "",
  lastLogin1115Historical: true,
  providers: {
    capital: {
      brokerActionRequired: false,
      blockingCode: "",
    },
  },
};
const latest = {
  status: "connected",
  overallReady: true,
  brokerActionRequired: false,
  currentBlockingCode: "",
  quoteUniverseCount: 18404,
};
const targetEvent = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: capitalHftTimestamp(new Date(), 1),
  eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
  message:
    "收到群益報價事件: SKQuoteLib.OnNotifyQuoteLONG stockNo=TX00 name=台指近 close=4234000 bid=4234100 ask=4234600 qty=59461 decimal=2",
  stockNo: "TX00",
  stockName: "台指近",
  close: "4234000",
  bid: "4234100",
  ask: "4234600",
  decimal: "2",
  qty: "59461",
};
const tx06Event = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: capitalHftTimestamp(new Date(), 0),
  eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
  message:
    "收到群益報價事件: SKQuoteLib.OnNotifyQuoteLONG stockNo=TX06 name=台指06 close=4229000 bid=4229000 ask=4229100 qty=381 decimal=2",
  stockNo: "TX06",
  stockName: "台指06",
  close: "4229000",
  bid: "4229000",
  ask: "4229100",
  decimal: "2",
  qty: "381",
};
const noiseEvent = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: capitalHftTimestamp(new Date(), 0),
  eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
  message:
    "收到群益報價事件: SKQuoteLib.OnNotifyQuoteLONG stockNo=TX12AM name=台指12 close=4299000 bid=4297000 ask=4299000 qty=18 decimal=2",
  stockNo: "TX12AM",
  stockName: "台指12",
  close: "4299000",
  bid: "4297000",
  ask: "4299000",
  qty: "18",
};
const a50Event = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: capitalHftTimestamp(new Date(), 2),
  eventSource: "SKOSQuoteLib.OnNotifyQuoteLONG",
  message:
    "收到群益報價事件: SKOSQuoteLib.OnNotifyQuoteLONG stockNo=CN0000 name=A50指熱2605 close=1570100 bid=1570000 ask=1570200 qty=9833 decimal=2",
  stockNo: "CN0000",
  stockName: "A50指熱2605",
  close: "1570100",
  bid: "1570000",
  ask: "1570200",
  decimal: "2",
  qty: "9833",
};

await fs.writeFile(
  path.join(stateDir, "openclaw_quote_bridge.json"),
  `${JSON.stringify(bridge, null, 2)}\n`,
);
await fs.writeFile(
  path.join(stateDir, "latest_quote_state.json"),
  `${JSON.stringify(latest, null, 2)}\n`,
);
await fs.writeFile(
  path.join(stateDir, "capital_latest_quote_event.json"),
  `${JSON.stringify(noiseEvent, null, 2)}\n`,
);
await fs.writeFile(
  path.join(stateDir, "capital_quote_events.jsonl"),
  `${JSON.stringify(targetEvent)}\n${JSON.stringify(tx06Event)}\n${JSON.stringify(noiseEvent)}\n`,
);
await fs.writeFile(
  path.join(stateDir, "os_latest_quote_event.json"),
  `${JSON.stringify(a50Event, null, 2)}\n`,
);

const state = await readCapitalQuoteState({ repoRoot, stateDir, marketCode: "TXF" });
if (!state.ready) {
  throw new Error(`expected ready=true, got ${JSON.stringify(state)}`);
}
if (state.status !== "connected") {
  throw new Error(`expected connected, got ${state.status}`);
}
if (state.quote.eventSource !== "SKQuoteLib.OnNotifyQuoteLONG") {
  throw new Error(`unexpected event source: ${state.quote.eventSource}`);
}
if (state.quote.stockNo !== "TX06") {
  throw new Error(`unexpected stockNo: ${state.quote.stockNo}`);
}
if (state.selection?.targetStockNo !== "TX06") {
  throw new Error(`unexpected targetStockNo: ${state.selection?.targetStockNo}`);
}
if (
  state.quote.close !== "42290.00" ||
  state.quote.bid !== "42290.00" ||
  state.quote.ask !== "42291.00"
) {
  throw new Error(`unexpected TXF normalized quote: ${JSON.stringify(state.quote)}`);
}
if (state.quote.rawClose !== "4229000" || !state.quote.normalizedByDecimal) {
  throw new Error(
    `expected TXF raw quote proof and decimal normalization: ${JSON.stringify(state.quote)}`,
  );
}
if (state.selection?.marketCode !== "TXF") {
  throw new Error(`unexpected marketCode: ${state.selection?.marketCode}`);
}
if (
  !Array.isArray(state.selection?.targetStockNos) ||
  !state.selection.targetStockNos.includes("TXF")
) {
  throw new Error(
    `unexpected TXF alias coverage: ${JSON.stringify(state.selection?.targetStockNos)}`,
  );
}
if (
  !Array.isArray(state.selection?.targetStockNos) ||
  !state.selection.targetStockNos.includes("TX00")
) {
  throw new Error(`unexpected targetStockNos: ${JSON.stringify(state.selection?.targetStockNos)}`);
}
if (
  !Array.isArray(state.selection?.targetStockNos) ||
  !state.selection.targetStockNos.includes("TX06")
) {
  throw new Error(
    `TXF month universe must include current-month TX06: ${JSON.stringify(state.selection?.targetStockNos)}`,
  );
}
if (state.selection.targetStockNos.some((stockNo) => /^TX05(?:AM|PM)?$/.test(stockNo))) {
  throw new Error(
    `TXF aliases must not include TX05 contracts: ${JSON.stringify(state.selection?.targetStockNos)}`,
  );
}
if (!Number.isFinite(state.quoteEventAgeSeconds)) {
  throw new Error(`expected numeric quoteEventAgeSeconds, got ${state.quoteEventAgeSeconds}`);
}
if (!["fresh", "stale"].includes(state.quoteEventFreshness)) {
  throw new Error(`unexpected quoteEventFreshness: ${state.quoteEventFreshness}`);
}
if (
  !Number.isFinite(state.quoteEventFreshnessThresholdSeconds) ||
  state.quoteEventFreshnessThresholdSeconds <= 0
) {
  throw new Error(
    `unexpected quoteEventFreshnessThresholdSeconds: ${state.quoteEventFreshnessThresholdSeconds}`,
  );
}

const tx06State = await readCapitalQuoteState({ repoRoot, stateDir, marketCode: "TX06" });
if (!tx06State.ready) {
  throw new Error(`expected TX06 ready=true, got ${JSON.stringify(tx06State)}`);
}
if (tx06State.selection?.targetStockNo !== "TX06") {
  throw new Error(`unexpected TX06 targetStockNo: ${tx06State.selection?.targetStockNo}`);
}
if (tx06State.quote.close !== "42290.00" || tx06State.quote.ask !== "42291.00") {
  throw new Error(`unexpected TX06 normalized quote: ${JSON.stringify(tx06State.quote)}`);
}
if (
  !Array.isArray(tx06State.selection?.targetStockNos) ||
  !tx06State.selection.targetStockNos.includes("TX06AM")
) {
  throw new Error(
    `expected TX06 aliases to include TX06AM: ${JSON.stringify(tx06State.selection?.targetStockNos)}`,
  );
}
if (tx06State.selection.targetStockNos.includes("TX00")) {
  throw new Error(
    `TX06 aliases must not include TX00 front-month aliases: ${JSON.stringify(tx06State.selection?.targetStockNos)}`,
  );
}
if (tx06State.selection.targetStockNos.some((stockNo) => /^TX05(?:AM|PM)?$/.test(stockNo))) {
  throw new Error(
    `TX06 aliases must not include expired TX05 contracts: ${JSON.stringify(tx06State.selection?.targetStockNos)}`,
  );
}

const a50State = await readCapitalQuoteState({ repoRoot, stateDir, marketCode: "A50" });
if (!a50State.ready) {
  throw new Error(`expected A50 ready=true, got ${JSON.stringify(a50State)}`);
}
if (a50State.selection?.marketCode !== "A50") {
  throw new Error(`unexpected A50 marketCode: ${a50State.selection?.marketCode}`);
}
if (a50State.quote.stockNo !== "CN0000") {
  throw new Error(`unexpected A50 stockNo: ${a50State.quote.stockNo}`);
}
if (a50State.quote.close !== "15701.00") {
  throw new Error(`unexpected A50 normalized close: ${a50State.quote.close}`);
}
if (!a50State.quote.normalizedByDecimal) {
  throw new Error(
    `A50 CN0000 event should be decimal-normalized: ${a50State.quote.normalizedByDecimal}`,
  );
}
if (a50State.selection?.targetStockNo !== "CN0000") {
  throw new Error(`unexpected A50 targetStockNo: ${a50State.selection?.targetStockNo}`);
}
if (
  !Array.isArray(a50State.selection?.targetStockNos) ||
  !a50State.selection.targetStockNos.includes("A50")
) {
  throw new Error(
    `unexpected A50 targetStockNos: ${JSON.stringify(a50State.selection?.targetStockNos)}`,
  );
}
if (
  !Array.isArray(a50State.selection?.targetStockNos) ||
  !a50State.selection.targetStockNos.includes("CN0000")
) {
  throw new Error(
    `unexpected CN0000 targetStockNos: ${JSON.stringify(a50State.selection?.targetStockNos)}`,
  );
}
if (a50State.selection.targetStockNos.some((stockNo) => /^(OJO05|FA5005)$/u.test(stockNo))) {
  throw new Error(
    `A50 targetStockNos must not include obsolete routes: ${JSON.stringify(a50State.selection?.targetStockNos)}`,
  );
}

const alreadyScaledTargetEvent = {
  ...targetEvent,
  receivedAt: capitalHftTimestamp(new Date(), 0),
  close: "42340",
  bid: "42341",
  ask: "42346",
};
await fs.writeFile(
  path.join(stateDir, "capital_latest_quote_event.json"),
  `${JSON.stringify(alreadyScaledTargetEvent, null, 2)}\n`,
);
await fs.writeFile(
  path.join(stateDir, "capital_quote_events.jsonl"),
  `${JSON.stringify(alreadyScaledTargetEvent)}\n`,
);
const alreadyScaledState = await readCapitalQuoteState({ repoRoot, stateDir, marketCode: "TXF" });
if (
  alreadyScaledState.quote.close !== "42340.00" ||
  alreadyScaledState.quote.bid !== "42341.00" ||
  alreadyScaledState.quote.ask !== "42346.00"
) {
  throw new Error(
    `quote reader must not divide already-scaled TXF prices twice: ${JSON.stringify(alreadyScaledState.quote)}`,
  );
}

const hftStateDir = path.join(tempRoot, "CapitalHftService");
await fs.mkdir(hftStateDir, { recursive: true });
await fs.writeFile(
  path.join(hftStateDir, "hft_service_status.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      status: "running",
      loginStatus: "connected",
      loginCode: 0,
      loginMethod: "SKCenterLib_LoginSetQuote:Y",
      quoteMonitorConnected: true,
      osQuoteConnected: true,
      accountsCount: 1,
      subscribedStocks: ["TX00"],
      subscribedOsStocks: ["CL0000", "CN0000"],
      quoteStats: { lastQuoteAt: new Date().toISOString() },
      osQuoteStats: { lastQuoteAt: new Date().toISOString() },
      riskControls: {
        allowLiveTrading: false,
        writeBrokerOrders: false,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(hftStateDir, "os_latest_quote_event.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-quote-event.v1",
      provider: "capital-os",
      receivedAt: new Date().toISOString(),
      eventSource: "SKOSQuoteLib.OnNotifyQuoteLONG",
      stockNo: "CN0000",
      stockName: "A50指熱2605",
      close: "1545400",
      bid: "1545400",
      ask: "1545600",
      qty: "79514",
      decimal: "2",
      rawSummary:
        "stockNo=CN0000 name=A50指熱2605 open=1540000 high=1550000 low=1530000 close=1545400 bid=1545400 ask=1545600 qty=79514 decimal=2",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(hftStateDir, "os_symbol_cache.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-symbol-cache.v1",
      generatedAt: new Date().toISOString(),
      symbolCount: 2,
      symbols: {
        CL0000: {
          symbol: "CL0000",
          instrument: "CL",
          name: "輕原油熱2607",
          price: 104.08,
          bid: 104.05,
          ask: 104.08,
          qty: 1219,
          time: new Date().toISOString(),
        },
        CN0000: {
          symbol: "CN0000",
          instrument: "CN",
          name: "A50指熱2605",
          price: 15447,
          bid: 15441,
          ask: 15470,
          qty: 74216,
          time: new Date().toISOString(),
        },
        GC0000: {
          symbol: "GC0000",
          instrument: "GC",
          name: "黃金熱2606",
          price: 2370.5,
          bid: 2370.4,
          ask: 2370.6,
          qty: 317,
          time: new Date().toISOString(),
        },
        ES0000: {
          symbol: "ES0000",
          instrument: "ES",
          name: "小標普熱2606",
          price: 5432.25,
          bid: 5432,
          ask: 5432.5,
          qty: 812,
          time: new Date().toISOString(),
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const hftClState = await readCapitalQuoteState({
  repoRoot,
  stateDir: hftStateDir,
  marketCode: "CL",
});
if (hftClState.source !== "CapitalHftService") {
  throw new Error(`expected CapitalHftService source, got ${hftClState.source}`);
}
if (!hftClState.ready) {
  throw new Error(`expected HFT CL ready=true, got ${JSON.stringify(hftClState)}`);
}
if (hftClState.selection?.targetStockNo !== "CL0000") {
  throw new Error(`unexpected HFT CL targetStockNo: ${hftClState.selection?.targetStockNo}`);
}
if (hftClState.quote.stockNo !== "CL0000") {
  throw new Error(`unexpected HFT CL stockNo: ${hftClState.quote.stockNo}`);
}
if (hftClState.selection?.source !== "os_symbol_cache") {
  throw new Error(`expected HFT CL os_symbol_cache source, got ${hftClState.selection?.source}`);
}

const hftA50State = await readCapitalQuoteState({
  repoRoot,
  stateDir: hftStateDir,
  marketCode: "A50",
});
if (!hftA50State.ready) {
  throw new Error(`expected HFT A50 ready=true, got ${JSON.stringify(hftA50State)}`);
}
if (hftA50State.selection?.source !== "latest_os_event") {
  throw new Error(`expected HFT A50 latest_os_event source, got ${hftA50State.selection?.source}`);
}
if (hftA50State.quote.close !== "15454.00") {
  throw new Error(`unexpected HFT A50 normalized close: ${hftA50State.quote.close}`);
}
if (hftA50State.quote.bid !== "15454.00" || hftA50State.quote.ask !== "15456.00") {
  throw new Error(`unexpected HFT A50 normalized bid/ask: ${JSON.stringify(hftA50State.quote)}`);
}
if (hftA50State.quote.rawClose !== "1545400" || !hftA50State.quote.normalizedByDecimal) {
  throw new Error(
    `expected raw OS quote proof and decimal normalization: ${JSON.stringify(hftA50State.quote)}`,
  );
}

const hftGoldState = await readCapitalQuoteState({
  repoRoot,
  stateDir: hftStateDir,
  marketCode: "GC",
});
if (!hftGoldState.ready) {
  throw new Error(`expected HFT GC ready=true, got ${JSON.stringify(hftGoldState)}`);
}
if (hftGoldState.selection?.targetStockNo !== "GC0000") {
  throw new Error(`unexpected HFT GC targetStockNo: ${hftGoldState.selection?.targetStockNo}`);
}
if (
  !Array.isArray(hftGoldState.selection?.targetStockNos) ||
  !hftGoldState.selection.targetStockNos.includes("MGC0000")
) {
  throw new Error(
    `expected HFT GC aliases to include MGC0000: ${JSON.stringify(hftGoldState.selection?.targetStockNos)}`,
  );
}
if (
  hftGoldState.quote.close !== "2370.5" ||
  hftGoldState.quote.bid !== "2370.4" ||
  hftGoldState.quote.ask !== "2370.6"
) {
  throw new Error(`unexpected HFT GC quote: ${JSON.stringify(hftGoldState.quote)}`);
}

const hftEsState = await readCapitalQuoteState({
  repoRoot,
  stateDir: hftStateDir,
  marketCode: "ES",
});
if (!hftEsState.ready) {
  throw new Error(`expected HFT ES ready=true, got ${JSON.stringify(hftEsState)}`);
}
if (hftEsState.selection?.targetStockNo !== "ES0000") {
  throw new Error(`unexpected HFT ES targetStockNo: ${hftEsState.selection?.targetStockNo}`);
}
if (
  !Array.isArray(hftEsState.selection?.targetStockNos) ||
  !hftEsState.selection.targetStockNos.includes("MES0000")
) {
  throw new Error(
    `expected HFT ES aliases to include MES0000: ${JSON.stringify(hftEsState.selection?.targetStockNos)}`,
  );
}

const output = path.join(repoRoot, ".openclaw", "quote", "capital-quote-state.json");
await writeCapitalQuoteState(state, output);
await fs.access(output);
await fs.access(`${output}.sha256`);

process.stdout.write("CAPITAL_QUOTE_READER_CHECK=OK\n");
