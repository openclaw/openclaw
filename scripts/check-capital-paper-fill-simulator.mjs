#!/usr/bin/env node
// check-capital-paper-fill-simulator.mjs — gate check for fill simulator
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperFillSimulation } from "./openclaw-capital-paper-fill-simulator.mjs";

async function assertLegacyAliasesAreBlocked() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-fill-"));
  const intentPath = path.join(tempRoot, ".openclaw", "trading", "capital-paper-intents.jsonl");
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  await fs.mkdir(path.dirname(intentPath), { recursive: true });
  await fs.writeFile(
    intentPath,
    `${JSON.stringify({
      intentId: "legacy-alias-must-block",
      symbol: "TX00AM",
      side: "buy",
      qty: 1,
      entryPrice: 100,
      targetPrice: 101,
      stopPrice: 99,
      allowLiveTrading: false,
      writeBrokerOrders: false,
    })}\n`,
    "utf8",
  );
  const legacyResult = await runCapitalPaperFillSimulation({
    repoRoot: tempRoot,
    intentsPath: intentPath,
    outputPath,
  });
  if (legacyResult.stats?.blocked_legacy_alias_count !== 1) {
    throw new Error(`Legacy alias was not blocked: ${JSON.stringify(legacyResult.stats)}`);
  }
  if (legacyResult.stats?.total_intents !== 0) {
    throw new Error(
      `Legacy alias leaked into fill simulation: ${JSON.stringify(legacyResult.stats)}`,
    );
  }
  if (legacyResult.stats?.normalized_legacy_alias_count !== 0) {
    throw new Error(
      `Legacy alias was normalized instead of blocked: ${JSON.stringify(legacyResult.stats)}`,
    );
  }
}

await assertLegacyAliasesAreBlocked();

async function assertGeneratedCurrentSourceIsPreferred() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-fill-source-"));
  const activeIntentPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-intents.jsonl",
  );
  const generatedIntentPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-current-paper-intents-from-target-registry.jsonl",
  );
  const outputPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-fill-simulation.json",
  );
  await fs.mkdir(path.dirname(activeIntentPath), { recursive: true });
  await fs.writeFile(
    activeIntentPath,
    `${JSON.stringify({
      intentId: "active-intent-should-not-win",
      symbol: "CL0000",
      side: "buy",
      qty: 1,
      entryPrice: 100,
      targetPrice: 101,
      stopPrice: 99,
      allowLiveTrading: false,
      writeBrokerOrders: false,
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    generatedIntentPath,
    `${JSON.stringify({
      intentId: "generated-current-intent-should-win",
      symbol: "ES0000",
      side: "buy",
      qty: 1,
      entryPrice: 100,
      targetPrice: 101,
      stopPrice: 99,
      allowLiveTrading: false,
      writeBrokerOrders: false,
    })}\n`,
    "utf8",
  );

  const result = await runCapitalPaperFillSimulation({
    repoRoot: tempRoot,
    outputPath,
  });
  if (path.resolve(result.source?.actualPath ?? "") !== generatedIntentPath) {
    throw new Error(`Generated current source was not preferred: ${JSON.stringify(result.source)}`);
  }
  if (result.source?.fallbackUsed === true) {
    throw new Error(
      `Generated current source must not be marked fallback: ${JSON.stringify(result.source)}`,
    );
  }
  if (result.source?.fallbackReason !== "generated_current_preferred") {
    throw new Error(`Generated current source reason missing: ${JSON.stringify(result.source)}`);
  }
}

await assertGeneratedCurrentSourceIsPreferred();

const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-paper-fill-live-probe-"));
const result = await runCapitalPaperFillSimulation({
  repoRoot: process.cwd(),
  outputPath: path.join(probeRoot, "capital-paper-fill-simulation.json"),
});

// Gate: must have schema and not error
if (!result.schema?.startsWith("openclaw.capital.paper-fill-simulation")) {
  throw new Error(`Fill simulator returned unexpected schema: ${result.schema}`);
}

// If no intents yet, that is OK (status: no_intents) — not a failure
if (result.status === "no_intents") {
  process.stdout.write("CAPITAL_PAPER_FILL_SIMULATION_CHECK=OK (no_intents)\n");
  process.exit(0);
}

// Sanity: stats must be numbers
const { stats } = result;
if (typeof stats?.fill_rate !== "number" || typeof stats?.total_intents !== "number") {
  throw new Error(`Fill simulator stats malformed: ${JSON.stringify(stats)}`);
}
if (result.status === "no_safe_intents") {
  if (stats.blocked_legacy_alias_count <= 0) {
    throw new Error(`No safe intents without a blocked legacy alias: ${JSON.stringify(stats)}`);
  }
  if (stats.total_intents !== 0 || stats.normalized_legacy_alias_count !== 0) {
    throw new Error(`Legacy alias must be blocked, not simulated: ${JSON.stringify(stats)}`);
  }
  process.stdout.write(
    `CAPITAL_PAPER_FILL_SIMULATION_CHECK=OK no_safe_intents blocked_legacy_aliases=${stats.blocked_legacy_alias_count}\n`,
  );
  process.exit(0);
}
if (result.readOnly !== true || result.loginAttempted !== false) {
  throw new Error("Fill simulator must stay read-only and must not login");
}
if (
  result.liveTradingEnabled !== false ||
  result.writeTradingEnabled !== false ||
  result.brokerOrderPathEnabled !== false
) {
  throw new Error("Fill simulator enabled a live/write broker flag");
}
if (
  result.safetyLock?.allowLiveTrading !== false ||
  result.safetyLock?.writeBrokerOrders !== false
) {
  throw new Error(`Fill simulator safety lock malformed: ${JSON.stringify(result.safetyLock)}`);
}
if (!result.summary || result.summary.total_intents !== stats.total_intents) {
  throw new Error("Fill simulator summary must mirror stats for report consumers");
}
if (stats.total_intents <= 0) {
  throw new Error("Fill simulator needs at least one paper intent or latest-intent fallback");
}
if (stats.unsafe_intent_count !== 0) {
  throw new Error(`Fill simulator accepted unsafe intents: ${stats.unsafe_intent_count}`);
}
if (stats.normalized_legacy_alias_count !== 0) {
  throw new Error(
    `Fill simulator normalized legacy aliases: ${stats.normalized_legacy_alias_count}`,
  );
}
if (result.source?.fallbackUsed === true) {
  if (!result.source?.fallbackReason) {
    throw new Error("Fill simulator fallback source must include fallbackReason");
  }
} else if (
  !["capital-paper-intents.jsonl", "capital-current-paper-intents-from-target-registry.jsonl"].some(
    (fileName) => String(result.source?.actualPath ?? "").endsWith(fileName),
  )
) {
  throw new Error(
    `Fill simulator source must be primary/generated current intents or latest fallback: ${result.source?.actualPath}`,
  );
}
if (result.source?.fallbackUsed !== true) {
  if (result.source?.sourceRecordCount !== stats.total_intents) {
    throw new Error(
      `Fill simulator sourceRecordCount must match simulated intents: ${JSON.stringify(result.source)}`,
    );
  }
  if (
    stats.total_intents > 0 &&
    !/^[A-F0-9]{64}$/.test(String(result.source?.sourceDigest ?? ""))
  ) {
    throw new Error(
      `Fill simulator sourceDigest missing or malformed: ${JSON.stringify(result.source)}`,
    );
  }
}
if (!Array.isArray(result.source?.intentRunIds)) {
  throw new Error(
    `Fill simulator must expose intentRunIds array: ${JSON.stringify(result.source)}`,
  );
}
if (result.monteCarlo?.iterations !== 500) {
  throw new Error(`Expected 500 Monte Carlo iterations, got ${result.monteCarlo?.iterations}`);
}

process.stdout.write(
  `CAPITAL_PAPER_FILL_SIMULATION_CHECK=OK fill_rate=${stats.fill_rate.toFixed(4)} total=${stats.total_intents}\n`,
);
