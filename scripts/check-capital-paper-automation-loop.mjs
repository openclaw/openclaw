import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperAutomationLoop } from "./openclaw-capital-paper-automation-loop.mjs";

const quoteScripts = [
  "capital-hft:quote:check",
  "capital-hft:quote:read",
  "capital-hft:quote:status",
  "capital-hft:quote:status:check",
  "capital-hft:quote:event",
  "capital-hft:quote:event:check",
  "capital-hft:quote:pump",
  "capital-hft:quote:pump:check",
  "capital-hft:quote:validate",
  "capital-hft:quote:architecture",
  "capital-hft:quote:architecture:check",
];

const architectureFiles = [
  "scripts/openclaw-capital-quote-reader.mjs",
  "scripts/check-capital-quote-reader.mjs",
  "scripts/openclaw-capital-quote-status.mjs",
  "scripts/check-capital-quote-status.mjs",
  "scripts/openclaw-capital-quote-pump.mjs",
  "scripts/check-capital-quote-pump.mjs",
  "scripts/openclaw-capital-quote-runtime-event.mjs",
  "scripts/check-capital-quote-runtime-event.mjs",
  "scripts/validate-capital-quote-state.mjs",
  "skills/capital-quotes/SKILL.md",
  "docs/automation/module-skill-inventory.md",
];

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value = "") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function baseStatus() {
  return {
    schema: "openclaw.capital.quote-status.v1",
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    status: "ready",
    ready: true,
    strategyGate: {
      ready: true,
      status: "allow_read_only_strategy_context",
    },
    guard: {
      active: false,
      lastCode: "",
      nextAllowedAt: "",
    },
    quoteProof: {
      status: "confirmed",
      freshness: "fresh",
      latestStock: "MXFFX999",
      latestStockName: "客小台現貨標的",
      freshnessStatus: "fresh",
      freshnessAgeSeconds: 1,
    },
    completion: {
      queueCompleted: true,
      openClawReady: true,
      openClawCompleted: true,
      lastRunStatus: "subscription-window-accepted",
      quoteUniverseCount: 18404,
      distinctQuoteCodeCount: 14622,
      completionUniverseCount: 14622,
      completionBasis: "distinctQuoteCodeCount",
      nextStartIndex: 14622,
    },
    monitors: {
      freshnessReady: true,
      mappingReady: true,
      classificationReady: true,
      allReadOnlyMonitorsReady: true,
      mappingFamilies: 409,
      classificationMappedRows: 14622,
      classificationDistinctQuoteCodes: 14622,
    },
    files: {},
  };
}

async function writeCapitalHftServiceState(stateDir, receivedAt) {
  await writeJson(path.join(stateDir, "openclaw_quote_bridge.json"), {
    status: "connected",
    overallReady: true,
    providers: {
      capital: {
        brokerActionRequired: false,
      },
    },
    currentBlockingCode: "",
    quoteUniverseCount: 18404,
  });
  await writeJson(path.join(stateDir, "latest_quote_state.json"), {
    brokerActionRequired: false,
    currentBlockingCode: "",
    quoteUniverseCount: 18404,
  });
  const quoteEvent = {
    receivedAt,
    eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
    stockNo: "MXFFX999",
    stockName: "客小台現貨標的",
    close: "4113885",
    bid: "4113880",
    ask: "4113881",
    qty: "3",
    message:
      "收到群益報價事件: SKQuoteLib.OnNotifyQuoteLONG stockNo=MXFFX999 name=客小台現貨標的 close=4113885 bid=4113880 ask=4113881 qty=3 decimal=2",
  };
  await writeJson(path.join(stateDir, "capital_latest_quote_event.json"), quoteEvent);
  await fs.writeFile(
    path.join(stateDir, "capital_quote_events.jsonl"),
    `${JSON.stringify(quoteEvent)}\n`,
  );
}

async function writeMinimalRepo(repoRoot) {
  const scripts = Object.fromEntries(
    quoteScripts.map((script) => [script, "node placeholder.mjs"]),
  );
  await writeJson(path.join(repoRoot, "package.json"), { scripts });
  for (const relativePath of architectureFiles) {
    if (relativePath === "skills/capital-quotes/SKILL.md") {
      await writeText(
        path.join(repoRoot, relativePath),
        [
          "Does not log in to 群益.",
          "Does not place orders.",
          "Does not read or store account passwords",
          "Treats stale, blocked, incomplete, or cooldown states as strategy-gate denial.",
          "Emits a runtime event",
        ].join("\n"),
      );
    } else {
      await writeText(path.join(repoRoot, relativePath), "");
    }
  }
  await writeJson(path.join(repoRoot, "config", "capital-paper-hft-risk-controls.json"), {
    schema: "openclaw.capital.paper-hft-risk-controls.v1",
    mode: "paper",
    allowLiveTrading: false,
    writeBrokerOrders: false,
    requireManualLiveArm: true,
    requireQuoteArchitecturePassed: true,
    requireStrategyGateReady: true,
    requireFreshQuoteStatus: "fresh",
    maxDecisionQuoteAgeSeconds: 2,
    decisionLoopIntervalMs: 250,
    maxPaperIntentsPerSecond: 4,
    maxPaperIntentsPerMinute: 120,
    maxPositionContracts: 1,
    killSwitchRequired: true,
    paperLedgerRequired: true,
    allowedSymbols: ["MXFFX999"],
  });
  await writeJson(path.join(repoRoot, "config", "capital-paper-microstructure-strategy.json"), {
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
  });
  await writeJson(
    path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json"),
    baseStatus(),
  );
}

async function runFixture(ageSeconds) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-paper-loop-"));
  const stateDir = path.join(repoRoot, "CapitalHftService", "state");
  await writeMinimalRepo(repoRoot);
  await writeCapitalHftServiceState(stateDir, capitalHftTimestamp(new Date(), ageSeconds));
  return runCapitalPaperAutomationLoop({
    repoRoot,
    stateDir,
  });
}

const fresh = await runFixture(1);
if (fresh.report.status !== "paper_intent_created") {
  throw new Error(`fresh loop should create paper intent, got ${fresh.report.status}`);
}
if (!fresh.report.files.assistantStatePath) {
  throw new Error("fresh loop must expose assistant state path");
}
if (
  !Object.is(fresh.report.trading.paperIntentCreated, true) ||
  !fresh.report.files.paperIntentPath
) {
  throw new Error("fresh loop must write a paper-only intent");
}
if (
  !Object.is(fresh.report.loginAttempted, false) ||
  !Object.is(fresh.report.liveTradingEnabled, false) ||
  !Object.is(fresh.report.writeTradingEnabled, false) ||
  !Object.is(fresh.report.brokerOrderPathEnabled, false)
) {
  throw new Error("paper loop must stay no-login and no-trading");
}
const freshAssistantState = JSON.parse(
  await fs.readFile(fresh.report.files.assistantStatePath, "utf8"),
);
if (freshAssistantState.status !== fresh.report.status) {
  throw new Error(
    `assistant state must mirror fresh loop status, got ${freshAssistantState.status}`,
  );
}
await fs.access(`${fresh.report.files.assistantStatePath}.sha256`);
const freshCanonicalStrategyPath = path.join(
  path.dirname(fresh.report.files.reportPath),
  "capital-strategy-engine-latest.json",
);
try {
  await fs.access(freshCanonicalStrategyPath);
  throw new Error("paper loop must not write the standalone strategy-engine latest report");
} catch (err) {
  if (err?.code !== "ENOENT") {
    throw err;
  }
}
await fs.access(
  path.join(
    path.dirname(fresh.report.files.reportPath),
    "capital-paper-loop-strategy-engine-latest.json",
  ),
);
const freshActivePaperIntents = await fs.readFile(
  path.join(path.dirname(fresh.report.files.reportPath), "capital-paper-intents.jsonl"),
  "utf8",
);
if (!freshActivePaperIntents.trim()) {
  throw new Error("paper loop strategy engine must not clear active paper intents");
}
if (fresh.report.learning.paperEvaluation?.staleSource !== false) {
  throw new Error("paper loop must refresh fill simulation/evaluator before auto-review");
}
if (
  fresh.report.learning.autoReview?.status &&
  fresh.report.learning.paperEvaluation?.blockers?.includes("stale_fill_simulation_source_empty")
) {
  throw new Error("paper loop auto-review must not be based on stale fill simulation evidence");
}

const stale = await runFixture(10);
if (stale.report.status !== "blocked_readiness") {
  throw new Error(`stale loop should block readiness, got ${stale.report.status}`);
}
if (stale.report.pump.status !== "stale" || stale.report.trading.paperIntentCreated) {
  throw new Error("stale loop must deny paper intent");
}
if (!stale.report.files.assistantStatePath) {
  throw new Error("stale loop must expose assistant state path");
}
const staleAssistantState = JSON.parse(
  await fs.readFile(stale.report.files.assistantStatePath, "utf8"),
);
if (staleAssistantState.status !== "blocked_quote_stale") {
  throw new Error(
    `stale assistant state should reflect stale quote gate, got ${staleAssistantState.status}`,
  );
}
await fs.access(`${stale.report.files.assistantStatePath}.sha256`);

process.stdout.write("CAPITAL_PAPER_AUTOMATION_LOOP_CHECK=OK\n");
