/**
 * Synthetic rollup publication through the real refresh lock and agent writer.
 * node --import ./scripts/tsx.mjs scripts/perf/usage-rollup-write-measure.ts \
 *   --root .local/rollup-fixture --prepare --sessions 20000
 * Repeat without --prepare; alternate --revision BASE and the working tree, five
 * pairs plus A/A controls. Timing, allocation, plans and CPU profiles are separate
 * passes. Seeding, encoding, admission, warmup and output hashing are not timed.
 * Acceptance: byte-identical rows after every scenario; no table scans; lower
 * writer hold and CPU beyond A/A spread, with allocation regressions reported.
 * This measures the storage owner on a synthetic cache, not whole-Gateway latency
 * or filesystem behavior on a production host. Never point it at an existing store.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    sessions: { type: "string", default: "20000" },
    months: { type: "string", default: "24" },
    batch: { type: "string", default: "25" },
    samples: { type: "string", default: "5" },
    revision: { type: "string" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
    stats: { type: "string", default: "stale" },
    scenario: { type: "string", default: "all" },
  },
});
assert(values.root, "--root must name a task-owned synthetic fixture");
assert(["timing", "allocation", "plans", "profile"].includes(values.mode));
assert(["stale", "fresh", "missing"].includes(values.stats));
assert(["all", "append", "replace", "remove"].includes(values.scenario));
const positive = (value: string) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n > 0);
  return n;
};
const sessions = positive(values.sessions);
const months = positive(values.months);
const batch = positive(values.batch);
const samples = positive(values.samples);
assert(batch * 7 < sessions);
const root = path.resolve(values.root);
const manifest = path.join(root, "rollup-fixture.json");
if (values.prepare) {
  mkdirSync(root); // Refuse existing directories, including real stores.
  writeFileSync(manifest, JSON.stringify({ sessions, months }));
}
assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), { sessions, months });
const ownerPath = "src/infra/session-cost-usage-partitions.worker.ts";
const source = values.revision
  ? execFileSync("git", ["show", `${values.revision}:${ownerPath}`], { encoding: "utf8" })
  : readFileSync(ownerPath, "utf8");
const sourcePath = path.join(root, "measured-owner.ts");
writeFileSync(sourcePath, source);
const log = path.join(root, `${values.label}-${values.mode}.jsonl`);
writeFileSync(log, "");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_LOG_FILE: path.join(root, "gateway.log"),
  ROLLUP_MEASURE_SOURCE: sourcePath,
  ROLLUP_MEASURE_LOG: log,
  ROLLUP_MEASURE_MODE: values.mode,
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS,
    `--require=${JSON.stringify(path.resolve("scripts/lib/usage-rollup-write-observer.cjs"))}`,
  ]
    .filter(Boolean)
    .join(" "),
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { prepareSessionCostUsageRefreshLock } =
  await import("../../src/infra/session-cost-usage-cache.sqlite.js");
const { partitionUsageCostRollup, usageCostPartitionKey, USAGE_COST_PARTITION_SCOPE } =
  await import("../../src/infra/session-cost-usage-partitions.js");
const { USAGE_COST_ROLLUP_VERSION, USAGE_COST_ROLLUP_SCOPE } =
  await import("../../src/infra/session-cost-usage-rollup-codec.js");
const { USAGE_COST_QUARTER_SCOPE } = await import("../../src/infra/session-cost-usage-quarters.js");
const { createSessionUsageRollupData, appendSessionUsageRollupContribution } =
  await import("../../src/infra/session-cost-usage-rollup.js");
setRuntimeConfigSnapshot({});
const rollup = createSessionUsageRollupData();
for (let month = 0; month < months; month++) {
  for (let day = 0; day < 24; day++) {
    appendSessionUsageRollupContribution(rollup, {
      timestamp: Date.UTC(2024, month, day + 1, 12, (day % 2) * 15),
      role: "assistant",
      model: "fixture",
      provider: "synthetic",
      toolNames: ["read"],
      toolResultCounts: { total: 1, errors: 0 },
    });
  }
}
const encoded = partitionUsageCostRollup({
  version: USAGE_COST_ROLLUP_VERSION,
  pricingFingerprint: "synthetic",
  scannedAt: 1,
  parsedRecords: months * 24,
  countedRecords: months * 24,
  checkpoint: {
    kind: "sqlite",
    maxSeq: months * 24,
    eventCount: months * 24,
    size: months * 24 * 8192,
    mtimeMs: 1,
    anchorHash: "synthetic",
  },
  rollup,
});
const agentId = "rollup-write";
const opened = openOpenClawAgentDatabase({ agentId });
const db = opened.db;
const id = (i: number) =>
  `/synthetic/agents/rollup-write/sessions/session-${String(i).padStart(6, "0")}.jsonl`;
const insert = db.prepare(
  "INSERT INTO cache_entries(scope,key,value_json,blob,expires_at,updated_at) VALUES(?,?,?,?,NULL,1)",
);
if (values.prepare) {
  db.exec("BEGIN");
  for (let i = 0; i < sessions; i++) {
    insert.run(USAGE_COST_ROLLUP_SCOPE, id(i), encoded.valueJson, encoded.blob);
    for (const p of encoded.partitions) {
      insert.run(
        USAGE_COST_PARTITION_SCOPE,
        usageCostPartitionKey(id(i), p.date),
        p.valueJson,
        p.blob,
      );
      insert.run(
        USAGE_COST_QUARTER_SCOPE,
        usageCostPartitionKey(id(i), p.date),
        p.quarters!.valueJson,
        p.quarters!.blob,
      );
    }
    if (i === 0) {
      db.exec("ANALYZE cache_entries");
    }
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  writeFileSync(
    path.join(root, "seed-statistics.json"),
    JSON.stringify(db.prepare("SELECT * FROM sqlite_stat1 WHERE tbl='cache_entries'").all()),
  );
}
// Restore the measured statistics before the worker opens, without reseeding data.
db.exec("DELETE FROM sqlite_stat1 WHERE tbl='cache_entries'");
if (values.stats === "fresh") {
  db.exec("ANALYZE cache_entries");
}
if (values.stats === "stale") {
  const stats: { tbl: string; idx: string; stat: string }[] = JSON.parse(
    readFileSync(path.join(root, "seed-statistics.json"), "utf8"),
  );
  const store = db.prepare("INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES(?,?,?)");
  for (const row of stats) {
    store.run(row.tbl, row.idx, row.stat);
  }
}
db.exec("ANALYZE sqlite_schema");
// Give every run the same post-refresh starting rows, including the first run.
const reset = db.prepare(`INSERT INTO cache_entries(scope,key,value_json,blob,expires_at,updated_at)
  VALUES(?,?,?,?,NULL,2) ON CONFLICT(scope,key) DO UPDATE SET
  value_json=excluded.value_json,blob=excluded.blob,expires_at=NULL,updated_at=2`);
const remove = db.prepare("DELETE FROM cache_entries WHERE scope=? AND key=?");
db.exec("BEGIN");
for (let i = 0; i < batch; i++) {
  const key = id(i * 7);
  reset.run(USAGE_COST_ROLLUP_SCOPE, key, encoded.valueJson, encoded.blob);
  for (const p of encoded.partitions) {
    reset.run(USAGE_COST_PARTITION_SCOPE, usageCostPartitionKey(key, p.date), p.valueJson, p.blob);
    reset.run(
      USAGE_COST_QUARTER_SCOPE,
      usageCostPartitionKey(key, p.date),
      p.quarters!.valueJson,
      p.quarters!.blob,
    );
  }
  for (const scope of [USAGE_COST_PARTITION_SCOPE, USAGE_COST_QUARTER_SCOPE]) {
    remove.run(scope, usageCostPartitionKey(key, encoded.partitions[0]!.date));
  }
}
db.exec("COMMIT");
const owner = await prepareSessionCostUsageRefreshLock(agentId);
try {
  assert(await owner.acquire());
  console.log(
    JSON.stringify({
      label: values.label,
      mode: values.mode,
      stats: values.stats,
      sessions,
      months,
      batch,
      bytes: statSync(opened.path).size,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      statistics: db.prepare("SELECT * FROM sqlite_stat1 WHERE tbl='cache_entries'").all(),
      load: loadavg(),
      node: process.version,
    }),
  );
  for (const scenario of ["append", "replace", "remove"] as const) {
    if (values.scenario !== "all" && values.scenario !== scenario) {
      continue;
    }
    const rows = Array.from({ length: batch }, (_, i) => ({
      rollupId: id(i * 7),
      valueJson: new TextEncoder().encode(encoded.valueJson),
      blob: encoded.blob,
      updatedAt: 2,
      partitions: scenario === "replace" ? encoded.partitions : [encoded.partitions.at(-1)!],
      replacePartitions: scenario === "replace",
      removedDates: scenario === "remove" ? [encoded.partitions[0]!.date] : [],
    }));
    for (let sample = -1; sample < samples; sample++) {
      if (scenario === "remove") {
        // Every sample must delete real rows, not just probe last sample's missing keys.
        const month = encoded.partitions[0]!;
        db.exec("BEGIN");
        for (const row of rows) {
          const key = usageCostPartitionKey(row.rollupId, month.date);
          reset.run(USAGE_COST_PARTITION_SCOPE, key, month.valueJson, month.blob);
          reset.run(USAGE_COST_QUARTER_SCOPE, key, month.quarters!.valueJson, month.quarters!.blob);
        }
        db.exec("COMMIT");
      }
      const cpu = process.cpuUsage();
      const start = performance.now();
      assert(await owner.writeRollup(rows));
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      console.log(
        JSON.stringify({ scenario, sample, elapsedMs, cpuMs: (used.user + used.system) / 1000 }),
      );
    }
    // Hash all rows at closeout; per-scenario hashes include every selected row.
    const digest = createHash("sha256");
    const query =
      scenario === "remove"
        ? db.prepare(
            "SELECT scope,key,value_json,blob,expires_at,updated_at FROM cache_entries ORDER BY scope,key",
          )
        : db.prepare(
            "SELECT scope,key,value_json,blob,expires_at,updated_at FROM cache_entries WHERE updated_at=2 ORDER BY scope,key",
          );
    for (const row of query.iterate()) {
      const { blob, ...metadata } = row;
      digest.update(JSON.stringify(metadata));
      if (blob instanceof Uint8Array) {
        digest.update(blob);
      }
    }
    console.log(JSON.stringify({ scenario, sha256: digest.digest("hex"), load: loadavg() }));
  }
} finally {
  await owner.release();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
