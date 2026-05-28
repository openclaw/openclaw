import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCapitalPaperTradingCycle,
  writeCapitalPaperTradingCycle,
} from "./openclaw-capital-paper-trading-simulator.mjs";

const strategy = {
  schema: "openclaw.capital.paper-microstructure-strategy.v1",
  strategyName: "capital-paper-microstructure-probe",
  mode: "paper",
  enabled: true,
  allowLiveTrading: false,
  writeBrokerOrders: false,
  symbol: "MXFFX999",
  quantity: 1,
  maxSpreadTicks: 4,
  tickSize: 1,
  intentTtlMs: 750,
  signalPolicy: "passive_bid_probe",
  requirePositiveBidAsk: true,
  learning: {
    status: "candidate",
    minReadyCyclesForPaper: 2,
    blockAfterConsecutiveReadinessBlocks: 2,
    promoteLiveAutomatically: false,
  },
};

const quoteState = {
  quote: {
    receivedAt: "2026-05-06 23:23:19.384",
    eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
    stockNo: "MXFFX999",
    stockName: "客小台現貨標的",
    close: "4113885",
    bid: "4113880",
    ask: "4113881",
    qty: "3",
    message: "decimal=2",
  },
};

const readyReadiness = {
  status: "ready_paper_hft",
  ready: true,
  liveTradingEnabled: false,
  writeTradingEnabled: false,
  brokerOrderPathEnabled: false,
  summary: {
    quoteAgeSeconds: 1,
  },
};

const blockedReadiness = {
  ...readyReadiness,
  status: "blocked_quote_not_realtime",
  ready: false,
  summary: {
    quoteAgeSeconds: 10,
  },
};

const readyCycle = buildCapitalPaperTradingCycle({
  readiness: readyReadiness,
  quoteState,
  strategy,
});
if (readyCycle.cycle.status !== "paper_intent_created") {
  throw new Error("ready paper HFT cycle should create paper intent");
}
if (readyCycle.cycle.paperIntent?.brokerOrderPathEnabled !== false) {
  throw new Error("paper intent must keep broker order path disabled");
}
if (readyCycle.cycle.paperIntent?.price !== 41138.8) {
  throw new Error(`unexpected scaled paper intent price: ${readyCycle.cycle.paperIntent?.price}`);
}

const txSessionAliasCycle = buildCapitalPaperTradingCycle({
  readiness: readyReadiness,
  quoteState: {
    quote: {
      ...quoteState.quote,
      stockNo: "TX06AM",
      stockName: "台指06",
      close: "4244200",
      bid: "4243600",
      ask: "4244200",
      message: "decimal=2",
    },
  },
  strategy: {
    ...strategy,
    symbol: "TX00AM",
    marketCode: "TXF",
    maxSpreadTicks: 40,
  },
});
if (txSessionAliasCycle.cycle.paperIntent?.symbol !== "TX06") {
  throw new Error(
    `TX session alias must be normalized to orderable paper symbol, got ${txSessionAliasCycle.cycle.paperIntent?.symbol}`,
  );
}
if (txSessionAliasCycle.cycle.paperIntent?.sourceEvent?.stockNo !== "TX06AM") {
  throw new Error("paper intent must preserve source callback stockNo");
}

const blockedCycle = buildCapitalPaperTradingCycle({
  readiness: blockedReadiness,
  quoteState,
  strategy,
});
if (blockedCycle.cycle.status !== "blocked_readiness" || blockedCycle.cycle.paperIntent) {
  throw new Error("blocked readiness must not create paper intent");
}

const invalidQuoteCycle = buildCapitalPaperTradingCycle({
  readiness: readyReadiness,
  quoteState: {
    quote: {
      ...quoteState.quote,
      bid: "0",
      ask: "0",
    },
  },
  strategy,
});
if (invalidQuoteCycle.cycle.status !== "blocked_quote") {
  throw new Error("invalid bid/ask must block paper intent");
}

const secondReadyCycle = buildCapitalPaperTradingCycle({
  readiness: readyReadiness,
  quoteState,
  strategy,
  previousLearning: readyCycle.learningRegistry,
});
if (secondReadyCycle.learningRegistry.status !== "approved_paper") {
  throw new Error("learning registry should promote to approved_paper after ready cycles");
}
if (secondReadyCycle.learningRegistry.liveEligible !== false) {
  throw new Error("learning registry must not auto-promote live eligibility");
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-paper-sim-"));
const files = await writeCapitalPaperTradingCycle(readyCycle, tempRoot);
await fs.access(files.latestCyclePath);
await fs.access(files.cycleStreamPath);
await fs.access(files.latestIntentPath);
await fs.access(files.intentStreamPath);
await fs.access(files.learningRegistryPath);
await fs.access(files.learningStreamPath);

process.stdout.write("CAPITAL_PAPER_TRADING_SIMULATOR_CHECK=OK\n");
