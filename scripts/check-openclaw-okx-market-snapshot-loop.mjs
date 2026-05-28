import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runOkxMarketSnapshotLoop } from "./openclaw-okx-market-snapshot-loop.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:market-loop"],
  "node scripts/openclaw-okx-market-snapshot-loop.mjs --interval-ms 1000 --write-state",
);
assert.equal(
  scripts["okx:market-loop:check"],
  "node scripts/check-openclaw-okx-market-snapshot-loop.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-market-snapshot-loop-latest.json",
);
const checkReportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-market-snapshot-loop-check-latest.json",
);
const checkLockPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-market-snapshot-loop.check.lock.json",
);

function assertLoopReport(report, source) {
  assert.equal(report.schema, "openclaw.okx.market-snapshot-loop.v1");
  assert.equal(report.provider, "okx");
  assert.equal(report.language, "zh-TW");
  assert.equal(report.mode, "read_only_1s_market_loop");
  assert.equal(report.status, "one_second_loop_ok");
  assert.equal(report.intervalMs, 1000);
  assert.ok(report.completedTicks >= 1);
  if (source === "fresh_loop_run") {
    assert.equal(report.requestedTicks, 3);
    assert.equal(report.completedTicks, 3);
  }
  assert.equal(report.blockers.length, 0);
  assert.equal(report.rateLimit.officialGetMarketTickersLimit, "20 requests per 2 seconds");
  assert.equal(report.rateLimit.requestsPerTick, 4);
  assert.equal(report.rateLimit.requestsPerSecondAtConfiguredInterval, 4);
  assert.equal(report.rateLimit.belowOfficialTickerLimit, true);
  assert.ok(report.latestTick.totalListedCount > 0);
  assert.ok(report.latestTick.totalWithLastPriceCount > 0);
  assert.ok(report.timing.maxTickDurationMs < 1000);
  for (const marker of ["spot_loop_ok", "swap_loop_ok", "futures_loop_ok", "option_loop_ok"]) {
    assert.ok(report.markers.includes(marker), `${marker} missing`);
  }
  for (const instType of ["SPOT", "SWAP", "FUTURES", "OPTION"]) {
    const snapshot = report.latestTick.snapshots.find((entry) => entry.instType === instType);
    assert.ok(snapshot, `${instType} loop snapshot missing`);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.code, `${instType.toLowerCase()}_loop_ok`);
    assert.ok(snapshot.listedCount > 0);
  }
  assert.equal(report.safety.readOnly, true);
  assert.equal(report.safety.accountCredentialRequired, false);
  assert.equal(report.safety.orderPlacementEnabled, false);
  assert.equal(report.safety.liveTradingEnabled, false);
  assert.equal(report.safety.writeTradingEnabled, false);
  assert.equal(report.safety.withdrawalEnabled, false);
  assert.equal(report.safety.submittedOrder, false);
  assert.equal(report.safety.credentialEchoed, false);
  assert.equal(report.safety.storesSecretsInRepo, false);
  assert.match(report.summary_zh_tw, /OKX 每秒報價 loop 可跑/u);
  assert.match(report.nextSafeTask, /paper-only strategy signal gate/u);
}

let report;
let outputReportPath = reportPath;
let validationSource = "fresh_loop_run";
try {
  report = await runOkxMarketSnapshotLoop({
    intervalMs: 1000,
    ticks: 3,
    outputPath: reportPath,
    writeState: true,
    quiet: true,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("BLOCKED_BY_ACTIVE_TASK")) {
    throw error;
  }
  validationSource = "parallel_check_run";
  outputReportPath = checkReportPath;
  report = await runOkxMarketSnapshotLoop({
    intervalMs: 1000,
    ticks: 3,
    outputPath: checkReportPath,
    lockPath: checkLockPath,
    writeState: true,
    quiet: true,
  });
}

assertLoopReport(report, validationSource);

const payload = await fs.readFile(outputReportPath, "utf8");
await fs.writeFile(
  `${outputReportPath}.sha256`,
  `${crypto.createHash("sha256").update(payload).digest("hex").toUpperCase()}\n`,
  "ascii",
);

process.stdout.write(
  [
    "OKX_MARKET_SNAPSHOT_LOOP_CHECK=OK",
    `status=${report.status}`,
    `validationSource=${validationSource}`,
    `reportPath=${path.relative(repoRoot, outputReportPath).replace(/\\/g, "/")}`,
    `intervalMs=${report.intervalMs}`,
    `completedTicks=${report.completedTicks}`,
    `maxTickDurationMs=${report.timing.maxTickDurationMs}`,
    `latestTotalListedCount=${report.latestTick.totalListedCount}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
