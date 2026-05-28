import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CapitalAdapter } from "./strategy-engine/brokers/CapitalAdapter.mjs";
import { OkxAdapter } from "./strategy-engine/brokers/OkxAdapter.mjs";
import { HftBrokerDispatcher } from "./strategy-engine/hft/HftBrokerDispatcher.mjs";
import { HftEngine } from "./strategy-engine/hft/HftEngine.mjs";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-hft-broker-dispatcher-latest.json",
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function check(id, ok, details = {}) {
  return { id, status: ok ? "pass" : "fail", ...details };
}

async function writeReport(report) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, json, "utf8");
  await fs.writeFile(`${REPORT_PATH}.sha256`, `${sha256(json)}\n`, "ascii");
}

async function main() {
  const events = [];
  const dispatcher = new HftBrokerDispatcher();

  const capitalPaper = await dispatcher.dispatchSignal({
    broker: "capital",
    strategy: "dispatcher_probe",
    instrument: "TX00",
    direction: "buy",
    qty: 1,
  });
  const okxPaper = await dispatcher.dispatchSignal({
    broker: "okx",
    strategy: "dispatcher_probe",
    instrument: "BTC/USDT:USDT",
    direction: "sell",
    qty: 0.01,
  });

  const engineDispatcher = new HftBrokerDispatcher();
  const engine = new HftEngine({
    dryRun: false,
    eventSink: (event) => events.push(event),
    dispatchSignal: (signal) => engineDispatcher.dispatchSignal(signal),
  });
  engine.addStrategy({
    name: "engine_dispatcher_probe",
    instrument: "TX00",
    enabled: true,
    popSignals() {
      return [
        {
          broker: "capital",
          strategy: "engine_dispatcher_probe",
          instrument: "TX00",
          direction: "buy",
          qty: 1,
          autoExecute: true,
        },
      ];
    },
  });
  await engine._processSignals();
  engine.stop();

  const liveBlockedDispatcher = new HftBrokerDispatcher({
    adapters: {
      capital: new CapitalAdapter({ mode: "live" }),
      okx: new OkxAdapter({ mode: "paper" }),
    },
  });
  const liveBlocked = await liveBlockedDispatcher.dispatchSignal({
    broker: "capital",
    strategy: "dispatcher_probe",
    instrument: "TX00",
    direction: "buy",
    qty: 1,
    dryRun: false,
  });

  const checks = [
    check("capital_paper_dispatch", capitalPaper.status === "paper_filled", {
      dispatchStatus: capitalPaper.status,
    }),
    check("okx_paper_dispatch", okxPaper.status === "paper_filled", {
      dispatchStatus: okxPaper.status,
    }),
    check("hft_engine_dispatcher_injection", engineDispatcher.events.length === 1, {
      eventCount: engineDispatcher.events.length,
    }),
    check("hft_engine_event_sink", events.length === 1, { eventCount: events.length }),
    check(
      "live_capital_blocked_by_promotion_gate",
      liveBlocked.status === "blocked_live_promotion",
      {
        dispatchStatus: liveBlocked.status,
        blockerCode: liveBlocked.promotionGate?.blockerCode ?? "",
      },
    ),
    check("no_live_order_sent", liveBlocked.sentOrder === false, {
      sentOrder: liveBlocked.sentOrder,
    }),
  ];

  const failedChecks = checks.filter((item) => item.status !== "pass");
  const report = {
    schema: "openclaw.hft-broker-dispatcher.v1",
    generatedAt: new Date().toISOString(),
    status: failedChecks.length === 0 ? "pass" : "fail",
    checks,
    failedChecks,
    safety: {
      brokerWriteAttempted: false,
      liveOrderEnabled: false,
      sentLiveOrder: false,
      promotionGateUsed: true,
    },
    dispatcherEvents: {
      paperDispatcher: dispatcher.events.length,
      engineDispatcher: engineDispatcher.events.length,
      liveBlockedDispatcher: liveBlockedDispatcher.events.length,
    },
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failedChecks.length > 0) {
    process.exitCode = 1;
  }
}

await main();
