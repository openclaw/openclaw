import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildOkxMarketSnapshotGate } from "./openclaw-okx-market-snapshot-gate.mjs";

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["okx:market-snapshot"],
  "node scripts/openclaw-okx-market-snapshot-gate.mjs --write-state --json",
);
assert.equal(
  scripts["okx:market-snapshot:check"],
  "node scripts/check-openclaw-okx-market-snapshot-gate.mjs",
);

const reportPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-okx-market-snapshot-gate-latest.json",
);
const report = await buildOkxMarketSnapshotGate();

assert.equal(report.schema, "openclaw.okx.market-snapshot-gate.v1");
assert.equal(report.provider, "okx");
assert.equal(report.language, "zh-TW");
assert.equal(report.mode, "read_only_market_snapshot");
assert.equal(report.status, "all_market_snapshots_ok");
assert.deepEqual(report.coverage.instTypes, ["SPOT", "SWAP", "FUTURES", "OPTION"]);
assert.equal(report.coverage.continuousStreamingEnabled, false);
assert.equal(report.coverage.snapshotOnly, true);
assert.ok(report.coverage.totalListedCount > 0);
assert.ok(report.coverage.totalWithLastPriceCount > 0);
assert.equal(report.blockers.length, 0);
for (const instType of report.coverage.instTypes) {
  const snapshot = report.snapshots.find((entry) => entry.instType === instType);
  assert.ok(snapshot, `${instType} snapshot missing`);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.code, `${instType.toLowerCase()}_snapshot_ok`);
  assert.ok(snapshot.listedCount > 0);
  assert.ok(snapshot.withTimestampCount > 0);
  assert.ok(snapshot.sample.length > 0);
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
assert.ok(report.commands.executed.every((command) => command.startsWith("okx market tickers ")));
assert.ok(report.commands.forbidden.some((command) => command === "okx spot place"));
assert.match(report.summary_zh_tw, /OKX 全商品類型 snapshot 可讀/u);
assert.match(report.nextSafeTask, /scheduler|snapshot/u);

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const payload = `${JSON.stringify(report, null, 2)}\n`;
await fs.writeFile(reportPath, payload, "utf8");
await fs.writeFile(
  `${reportPath}.sha256`,
  `${crypto.createHash("sha256").update(payload).digest("hex").toUpperCase()}\n`,
  "ascii",
);

process.stdout.write(
  [
    "OKX_MARKET_SNAPSHOT_GATE_CHECK=OK",
    `status=${report.status}`,
    `markers=${report.markers.join("/")}`,
    `totalListedCount=${report.coverage.totalListedCount}`,
    `totalWithLastPriceCount=${report.coverage.totalWithLastPriceCount}`,
    `summary=${report.summary_zh_tw}`,
    `nextSafeTask=${report.nextSafeTask}`,
  ].join("\n") + "\n",
);
