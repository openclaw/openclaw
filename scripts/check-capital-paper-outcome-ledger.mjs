#!/usr/bin/env node
// check-capital-paper-outcome-ledger.mjs - gate for the Capital paper outcome ledger.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperOutcomeLedger } from "./openclaw-capital-paper-outcome-ledger.mjs";

function assertSafety(result) {
  const safety = result.safetyLock ?? {};
  const forbiddenTrue = [
    result.allowLiveTrading,
    result.liveTradingEnabled,
    result.writeBrokerOrders,
    result.writeTradingEnabled,
    result.brokerOrderPathEnabled,
    result.brokerWriteAttempted,
    result.sentOrder,
    result.codexBrokerWriteAllowed,
    safety.allowLiveTrading,
    safety.liveTradingEnabled,
    safety.writeBrokerOrders,
    safety.writeTradingEnabled,
    safety.brokerOrderPathEnabled,
    safety.brokerWriteAttempted,
    safety.sentOrder,
    safety.codexBrokerWriteAllowed,
  ];
  if (forbiddenTrue.some((value) => value === true)) {
    throw new Error(`Paper outcome ledger enabled a live/write flag: ${JSON.stringify(safety)}`);
  }
  if (
    result.paperOnly !== true ||
    result.simulatedOnly !== true ||
    result.noLiveOrderSent !== true ||
    safety.paperOnly !== true ||
    safety.simulatedOnly !== true ||
    safety.noLiveOrderSent !== true
  ) {
    throw new Error(`Paper outcome ledger safety lock malformed: ${JSON.stringify(safety)}`);
  }
}

function assertStats(result) {
  const stats = result.stats ?? {};
  const numericFields = [
    "sampleCount",
    "filledCount",
    "stopHitCount",
    "takeProfitHitCount",
    "timeoutCount",
    "stopHitRate",
    "winRate",
    "fillRate",
    "timeoutRate",
    "totalPnlPts",
    "avgPnlPts",
    "totalPnlNotional",
    "avgPnlNotional",
    "scenariosPerIntent",
    "invalidIntentCount",
    "unsafeIntentCount",
    "blockedLegacyAliasCount",
  ];
  for (const field of numericFields) {
    if (typeof stats[field] !== "number" || Number.isNaN(stats[field])) {
      throw new Error(`Paper outcome ledger stat ${field} malformed: ${JSON.stringify(stats)}`);
    }
  }
  if (stats.unsafeIntentCount !== 0) {
    throw new Error(`Paper outcome ledger accepted unsafe intents: ${JSON.stringify(stats)}`);
  }
  if (stats.sampleCount !== stats.filledCount + stats.timeoutCount) {
    throw new Error(`Paper outcome sample accounting malformed: ${JSON.stringify(stats)}`);
  }
  if (stats.filledCount !== stats.stopHitCount + stats.takeProfitHitCount) {
    throw new Error(`Paper outcome fill accounting malformed: ${JSON.stringify(stats)}`);
  }
}

async function assertLegacyAliasesAreBlocked() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-outcome-ledger-"));
  try {
    const tradingDir = path.join(tempRoot, ".openclaw", "trading");
    await fs.mkdir(tradingDir, { recursive: true });
    await fs.writeFile(
      path.join(tradingDir, "capital-paper-intents.jsonl"),
      `${JSON.stringify({
        intentId: "legacy-alias-must-block",
        symbol: "TX00AM",
        qty: 1,
        entryPrice: 100,
        riskPts: 2,
        rewardPts: 4,
        paperOnly: true,
        allowLiveTrading: false,
        writeBrokerOrders: false,
      })}\n`,
      "utf8",
    );
    const result = await runCapitalPaperOutcomeLedger({ repoRoot: tempRoot });
    if (result.status !== "no_safe_intents" || result.stats.blockedLegacyAliasCount !== 1) {
      throw new Error(`Legacy alias was not blocked: ${JSON.stringify(result.stats)}`);
    }
    assertSafety(result);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await assertLegacyAliasesAreBlocked();

const result = await runCapitalPaperOutcomeLedger({ repoRoot: process.cwd() });

if (!result.schema?.startsWith("openclaw.capital.paper-outcome-ledger")) {
  throw new Error(`Unexpected paper outcome ledger schema: ${result.schema}`);
}

assertSafety(result);
assertStats(result);

if (result.status === "no_intents") {
  process.stdout.write("CAPITAL_PAPER_OUTCOME_LEDGER_CHECK=OK no_intents noLiveOrderSent=true\n");
  process.exit(0);
}

if (result.status === "no_safe_intents") {
  process.stdout.write(
    `CAPITAL_PAPER_OUTCOME_LEDGER_CHECK=OK no_safe_intents blocked_legacy_aliases=${result.stats.blockedLegacyAliasCount} noLiveOrderSent=true\n`,
  );
  process.exit(0);
}

if (result.status !== "ok") {
  throw new Error(`Paper outcome ledger returned non-ok status: ${result.status}`);
}

if (result.learningRegistryUpdated !== true) {
  throw new Error("Paper outcome ledger did not update learning registry outcomeStats");
}

if (
  result.learningRegistry?.outcomeStats?.sampleCount !== result.stats.sampleCount ||
  result.learningRegistry?.outcomeStats?.simulatedOnly !== true ||
  result.learningRegistry?.outcomeStats?.noLiveOrderSent !== true
) {
  throw new Error(
    `Learning registry outcomeStats mismatch: ${JSON.stringify(result.learningRegistry?.outcomeStats)}`,
  );
}

process.stdout.write(
  `CAPITAL_PAPER_OUTCOME_LEDGER_CHECK=OK status=${result.status} samples=${result.stats.sampleCount} stop_hit_rate=${result.stats.stopHitRate} win_rate=${result.stats.winRate} noLiveOrderSent=true\n`,
);
