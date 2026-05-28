import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readCapitalCoreProductFreshnessMatrix,
  writeCapitalCoreProductFreshnessMatrix,
} from "./openclaw-capital-core-product-freshness-matrix.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-core-matrix-"));
const repoRoot = path.join(tempRoot, "repo");
const stateDir = path.join(tempRoot, "CapitalHftService");
await fs.mkdir(path.join(repoRoot, ".openclaw", "quote"), { recursive: true });
await fs.mkdir(stateDir, { recursive: true });

const now = new Date("2026-05-19T13:20:00.000Z");
const domesticEvent = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-19T13:19:55.000Z",
  date: "20260519",
  time: "212000",
  ms: "0",
  eventSource: "SKQuoteLib.OnNotifyTicksLONG",
  stockNo: "TX00",
  stockName: "台指近",
  bid: "4023800",
  ask: "4024700",
  close: "4024800",
  qty: "1",
  decimal: "2",
};
const staleXeSnapshot = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-19T13:00:00.000Z",
  date: "20260519",
  time: "210000",
  ms: "0",
  eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
  stockNo: "XE0000AM",
  stockName: "歐元近",
  bid: "0",
  ask: "0",
  close: "0",
  qty: "0",
  decimal: "4",
};
const freshXeTick = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-19T13:19:58.000Z",
  date: "20260519",
  time: "211958",
  ms: "0",
  eventSource: "SKQuoteLib.OnNotifyTicksLONG",
  stockNo: "XE0000",
  stockName: "歐元近",
  bid: "11620",
  ask: "11625",
  close: "11625",
  qty: "1",
  decimal: "4",
};
const staleTeAmTick = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-19T12:00:00.000Z",
  date: "20260519",
  time: "200000",
  ms: "0",
  eventSource: "SKQuoteLib.OnNotifyTicksLONG",
  stockNo: "TE00AM",
  stockName: "電指近",
  bid: "259870",
  ask: "260405",
  close: "260405",
  qty: "1",
  decimal: "2",
};
const newerStaleTeTick = {
  schema: "capital-hft.capital.quote-event.v1",
  provider: "capital",
  receivedAt: "2026-05-19T13:00:00.000Z",
  date: "20260519",
  time: "210000",
  ms: "0",
  eventSource: "SKQuoteLib.OnNotifyTicksLONG",
  stockNo: "TE00",
  stockName: "電指近",
  bid: "259900",
  ask: "260410",
  close: "260410",
  qty: "1",
  decimal: "2",
};
await fs.writeFile(
  path.join(stateDir, "capital_quote_events.jsonl"),
  `${JSON.stringify(domesticEvent)}\n${JSON.stringify(staleXeSnapshot)}\n${JSON.stringify(freshXeTick)}\n${JSON.stringify(staleTeAmTick)}\n${JSON.stringify(newerStaleTeTick)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(stateDir, "os_symbol_cache.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-symbol-cache.v1",
      generatedAt: "2026-05-19T13:19:56.000Z",
      symbolCount: 4,
      symbols: {
        CN0000: {
          symbol: "CN0000",
          instrument: "CN",
          name: "A50指熱2605",
          price: 15450,
          bid: 15449,
          ask: 15451,
          qty: 100,
          time: "2026-05-19T13:19:56.000Z",
        },
        CL0000: {
          symbol: "CL0000",
          instrument: "CL",
          name: "輕原油熱2607",
          price: 104.34,
          bid: 104.33,
          ask: 104.35,
          qty: 100,
          time: "2026-05-19T13:19:57.000Z",
        },
        BZ0000: {
          symbol: "BZ0000",
          instrument: "BZ",
          name: "布蘭特油熱2607",
          price: 111.67,
          bid: 111.66,
          ask: 111.68,
          qty: 80,
          time: "2026-05-19T13:19:58.000Z",
        },
        CD0000: {
          symbol: "CD0000",
          instrument: "6C",
          name: "加幣熱2606",
          price: 7250,
          bid: 7249.5,
          ask: 7250,
          qty: 100,
          time: "2026-05-19T13:19:58.000Z",
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(stateDir, "hft_service_status.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.hft-service.v1",
      status: "running",
      loginStatus: "connected",
      subscribedStocks: ["TX00", "TX00AM", "TE00AM", "TE00"],
      subscribedOsStocks: ["CN0000", "CL0000", "BZ0000", "CD0000"],
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

const matrix = await readCapitalCoreProductFreshnessMatrix({
  repoRoot,
  stateDir,
  now,
  maxFreshSeconds: 300,
});

if (matrix.schema !== "openclaw.capital.core-product-freshness-matrix.v1") {
  throw new Error(`unexpected schema: ${matrix.schema}`);
}
if (!Object.is(matrix.readOnly, true) || matrix.loginAttempted || matrix.liveTradingEnabled) {
  throw new Error("matrix must stay read-only and no-login/no-live");
}
if (!matrix.ready || matrix.status !== "ready") {
  throw new Error(`expected ready matrix, got ${matrix.status}`);
}

const tx = matrix.products.find((product) => product.id === "tx-front");
if (!tx || tx.status !== "fresh" || tx.matchedSymbol !== "TX00") {
  throw new Error(`expected fresh TX00 product, got ${JSON.stringify(tx)}`);
}
if (tx.quote.timeBasis !== "broker_event_time") {
  throw new Error(`expected TX freshness to use broker_event_time, got ${tx.quote.timeBasis}`);
}
if (tx.quote.bid !== 40238 || tx.quote.ask !== 40247 || tx.quote.close !== 40248) {
  throw new Error(`expected scaled TX prices, got ${JSON.stringify(tx.quote)}`);
}
const txLegacyAlias = tx.aliases.find((alias) => alias.symbol === "TX00AM");
if (!txLegacyAlias || txLegacyAlias.matched) {
  throw new Error(
    `expected TX00AM to remain a non-matched legacy alias, got ${JSON.stringify(txLegacyAlias)}`,
  );
}
const txSessionAction = tx.diagnostic.recommendedActions.find(
  (action) => action.code === "verify_session_alias_subscription",
);
if (txSessionAction?.symbols?.some((symbol) => symbol === "TX00AM" || symbol === "TX00PM")) {
  throw new Error(
    `TX00AM/TX00PM must not be recommended as active session aliases, got ${JSON.stringify(tx.diagnostic)}`,
  );
}

const a50 = matrix.products.find((product) => product.id === "a50-hot");
if (!a50 || a50.status !== "fresh" || a50.matchedSymbol !== "CN0000") {
  throw new Error(`expected fresh A50 via CN0000, got ${JSON.stringify(a50)}`);
}
if (a50.aliases.some((alias) => /^(OJO05|FA5005)$/u.test(alias.symbol))) {
  throw new Error(
    `A50 aliases must not include obsolete OJO05/FA5005 routes: ${JSON.stringify(a50.aliases)}`,
  );
}

const te = matrix.products.find((product) => product.id === "te-front");
if (
  !te ||
  te.status !== "stale" ||
  te.matchedSymbol !== "TE00" ||
  te.diagnostic?.blockerCode !== "stale_callback"
) {
  throw new Error(
    `expected TE front to prefer newest stale TE00 diagnostic, got ${JSON.stringify(te)}`,
  );
}
const teDirectState = te.diagnostic.aliasStates.find((alias) => alias.symbol === "TE00");
const teAmState = te.diagnostic.aliasStates.find((alias) => alias.symbol === "TE00AM");
if (!teDirectState || !teAmState || !(teDirectState.ageSeconds < teAmState.ageSeconds)) {
  throw new Error(
    `expected TE diagnostic to compare TE00 newer than TE00AM, got ${JSON.stringify(te.diagnostic)}`,
  );
}
const teSessionAction = te.diagnostic.recommendedActions.find(
  (action) =>
    action.code === "verify_session_alias_subscription" && action.symbols.includes("TE00PM"),
);
if (!teSessionAction) {
  throw new Error(
    `expected TE diagnostic to recommend TE00PM session alias check, got ${JSON.stringify(te.diagnostic)}`,
  );
}

const crude = matrix.products.find((product) => product.id === "crude-oil-hot");
if (!crude || crude.status !== "fresh" || crude.matchedSymbol !== "CL0000") {
  throw new Error(`expected fresh crude oil via CL0000, got ${JSON.stringify(crude)}`);
}
if (crude.quote.bid !== 104.33 || crude.quote.ask !== 104.35 || crude.quote.close !== 104.34) {
  throw new Error(`expected CL0000 prices, got ${JSON.stringify(crude.quote)}`);
}

const brent = matrix.products.find((product) => product.id === "brent-oil-hot");
if (!brent || brent.status !== "fresh" || brent.matchedSymbol !== "BZ0000") {
  throw new Error(`expected fresh Brent oil via BZ0000, got ${JSON.stringify(brent)}`);
}
if (brent.quote.bid !== 111.66 || brent.quote.ask !== 111.68 || brent.quote.close !== 111.67) {
  throw new Error(`expected BZ0000 prices, got ${JSON.stringify(brent.quote)}`);
}

const cad = matrix.products.find((product) => product.id === "cad-hot");
if (!cad || cad.status !== "fresh" || cad.matchedSymbol !== "CD0000") {
  throw new Error(`expected fresh CAD via CD0000, got ${JSON.stringify(cad)}`);
}
if (
  cad.quote.priceScale !== 10000 ||
  cad.quote.bid !== 0.72495 ||
  cad.quote.ask !== 0.725 ||
  cad.quote.close !== 0.725
) {
  throw new Error(`expected scaled CD0000 prices, got ${JSON.stringify(cad.quote)}`);
}

const xe = matrix.products.find((product) => product.id === "xe-front");
if (!xe || xe.status !== "fresh" || xe.matchedSymbol !== "XE0000") {
  throw new Error(
    `expected fresh XE0000 to beat stale XE0000AM snapshot, got ${JSON.stringify(xe)}`,
  );
}
if (xe.quote.timeBasis !== "broker_event_time") {
  throw new Error(`expected XE freshness to use broker_event_time, got ${xe.quote.timeBasis}`);
}
if (xe.quote.bid !== 1.162 || xe.quote.ask !== 1.1625 || xe.quote.close !== 1.1625) {
  throw new Error(`expected scaled XE prices, got ${JSON.stringify(xe.quote)}`);
}
const xeStaleAlias = xe.aliases.find((alias) => alias.symbol === "XE0000AM");
if (!xeStaleAlias || !xeStaleAlias.seen || xeStaleAlias.matched) {
  throw new Error(
    `expected stale XE0000AM to be seen but not matched, got ${JSON.stringify(xeStaleAlias)}`,
  );
}
const xeStaleState = xe.diagnostic.aliasStates.find((alias) => alias.symbol === "XE0000AM");
if (!xeStaleState || !xeStaleState.zeroOrUnusablePrice) {
  throw new Error(
    `expected XE0000AM diagnostic to expose zero/unusable price state, got ${JSON.stringify(xe.diagnostic)}`,
  );
}
const xeSessionAction = xe.diagnostic.recommendedActions.find(
  (action) =>
    action.code === "verify_session_alias_subscription" && action.symbols.includes("XE0000PM"),
);
const xeZeroAction = xe.diagnostic.recommendedActions.find(
  (action) => action.code === "zero_price_root_cause",
);
if (!xeSessionAction) {
  throw new Error(
    `expected XE diagnostic to recommend XE0000PM check, got ${JSON.stringify(xe.diagnostic)}`,
  );
}
if (xe.status !== "fresh" && !xeZeroAction) {
  throw new Error(
    `expected blocked XE diagnostic to recommend zero-price root cause, got ${JSON.stringify(xe.diagnostic)}`,
  );
}

const outputPath = path.join(
  repoRoot,
  ".openclaw",
  "quote",
  "capital-core-product-freshness-matrix.json",
);
await writeCapitalCoreProductFreshnessMatrix({
  repoRoot,
  stateDir,
  now,
  maxFreshSeconds: 300,
  outputPath,
});
await fs.access(outputPath);
await fs.access(`${outputPath}.sha256`);

const interSessionStateDir = path.join(tempRoot, "CapitalHftServiceInterSession");
await fs.mkdir(interSessionStateDir, { recursive: true });
await fs.writeFile(
  path.join(interSessionStateDir, "capital_quote_events.jsonl"),
  `${JSON.stringify({
    schema: "capital-hft.capital.quote-event.v1",
    provider: "capital",
    receivedAt: "2026-05-20T05:29:55.177Z",
    date: "20260520",
    time: "132955",
    ms: "177000",
    eventSource: "SKQuoteLib.OnNotifyTicksLONG",
    stockNo: "TX00",
    stockName: "台指近",
    bid: "4007800",
    ask: "4007900",
    close: "4007800",
    qty: "1",
    decimal: "2",
  })}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(interSessionStateDir, "os_symbol_cache.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-symbol-cache.v1",
      generatedAt: "2026-05-20T05:59:56.000Z",
      symbols: {
        CN0000: {
          symbol: "CN0000",
          instrument: "CN",
          name: "A50指熱2605",
          price: 15450,
          bid: 15449,
          ask: 15451,
          qty: 100,
          time: "2026-05-20T05:59:56.000Z",
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(interSessionStateDir, "hft_service_status.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.hft-service.v1",
      status: "running",
      loginStatus: "connected",
      subscribedStocks: ["TX00"],
      subscribedOsStocks: ["CN0000"],
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

const interSessionMatrix = await readCapitalCoreProductFreshnessMatrix({
  repoRoot,
  stateDir: interSessionStateDir,
  now: new Date("2026-05-20T06:00:00.000Z"),
  maxFreshSeconds: 300,
});
if (interSessionMatrix.status !== "session_closed" || interSessionMatrix.ready) {
  throw new Error(
    `expected inter-session matrix to be session_closed/not ready, got ${JSON.stringify(interSessionMatrix)}`,
  );
}
if (interSessionMatrix.session?.domestic?.marketSession !== "inter_session") {
  throw new Error(
    `expected domestic inter_session, got ${JSON.stringify(interSessionMatrix.session)}`,
  );
}
const interSessionTx = interSessionMatrix.products.find((product) => product.id === "tx-front");
if (!interSessionTx || interSessionTx.status !== "session_closed") {
  throw new Error(`expected TX front session_closed, got ${JSON.stringify(interSessionTx)}`);
}
if (interSessionTx.ready) {
  throw new Error("inter-session TX front must not be quote-ready");
}
if (interSessionTx.diagnostic?.blockerCode !== "inter_session") {
  throw new Error(
    `expected inter_session blocker, got ${JSON.stringify(interSessionTx.diagnostic)}`,
  );
}
if (!interSessionMatrix.summary.sessionClosedRequiredIds.includes("tx-front")) {
  throw new Error(
    `expected tx-front in sessionClosedRequiredIds, got ${JSON.stringify(interSessionMatrix.summary)}`,
  );
}

const weekendStateDir = path.join(tempRoot, "CapitalHftServiceWeekend");
await fs.mkdir(weekendStateDir, { recursive: true });
await fs.writeFile(
  path.join(weekendStateDir, "capital_quote_events.jsonl"),
  `${JSON.stringify({
    schema: "capital-hft.capital.quote-event.v1",
    provider: "capital",
    receivedAt: "2026-05-22T21:00:00.000Z",
    date: "20260523",
    time: "050000",
    ms: "0",
    eventSource: "SKQuoteLib.OnNotifyTicksLONG",
    stockNo: "TX00",
    stockName: "台指近",
    bid: "4261000",
    ask: "4261200",
    close: "4261000",
    qty: "1",
    decimal: "2",
  })}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(weekendStateDir, "os_symbol_cache.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.os-symbol-cache.v1",
      generatedAt: "2026-05-23T01:00:00.000Z",
      symbols: {
        CN0000: {
          symbol: "CN0000",
          instrument: "CN",
          name: "A50指熱2605",
          price: 15361,
          bid: 15359,
          ask: 15363,
          qty: 100,
          time: "2026-05-23T01:00:00.000Z",
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(weekendStateDir, "hft_service_status.json"),
  `${JSON.stringify(
    {
      schema: "openclaw.capital.hft-service.v1",
      status: "running",
      loginStatus: "connected",
      subscribedStocks: ["TX00"],
      subscribedOsStocks: ["CN0000"],
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

const weekendMatrix = await readCapitalCoreProductFreshnessMatrix({
  repoRoot,
  stateDir: weekendStateDir,
  now: new Date("2026-05-23T01:00:00.000Z"),
  maxFreshSeconds: 300,
});
if (weekendMatrix.status !== "session_closed" || weekendMatrix.ready) {
  throw new Error(
    `expected weekend matrix to be session_closed/not ready, got ${JSON.stringify(weekendMatrix)}`,
  );
}
if (weekendMatrix.session?.domestic?.marketSession !== "session_closed") {
  throw new Error(
    `expected domestic weekend session_closed, got ${JSON.stringify(weekendMatrix.session)}`,
  );
}
const weekendTx = weekendMatrix.products.find((product) => product.id === "tx-front");
if (
  !weekendTx ||
  weekendTx.status !== "session_closed" ||
  weekendTx.diagnostic?.blockerCode !== "session_closed"
) {
  throw new Error(`expected weekend TX front session_closed, got ${JSON.stringify(weekendTx)}`);
}

process.stdout.write("CAPITAL_CORE_PRODUCT_FRESHNESS_MATRIX_CHECK=OK\n");
