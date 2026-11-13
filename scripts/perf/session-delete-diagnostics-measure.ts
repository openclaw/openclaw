/**
 * Below-threshold overhead of deletion's scoped native-statement timing.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-delete-diagnostics-measure.ts
 * A/A and five counterbalanced pairs use identical 16-statement native transactions;
 * only the operation label selects timing. No Gateway/large-DB latency claim.
 * Timing and sampled allocations run separately. All SQL and data are synthetic.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { observeConnection } from "../../src/infra/database-engine/observation.js";
import { runSqliteImmediateTransactionSync } from "../../src/infra/sqlite-transaction.js";

assert(globalThis.gc, "Run with --expose-gc");
const db = observeConnection(new DatabaseSync(":memory:"));
db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, payload TEXT)");
db.prepare("INSERT INTO entries VALUES (?, ?)").run(1, "synthetic-preserved-row");
const remove = db.prepare("DELETE FROM entries WHERE id = ?");
const iterations = 100_000;
const labels = { disabled: "session.synthetic-delete", enabled: "session.lifecycle.delete" };
let warningCount = 0;
const logger = {
  warn() {
    warningCount++;
  },
};
function run(enabled: boolean) {
  runSqliteImmediateTransactionSync(
    db,
    () => {
      for (let index = 0; index < 16; index++) {
        remove.run(100 + index);
      }
    },
    { operationLabel: enabled ? labels.enabled : labels.disabled, logger },
  );
}
const rows: object[] = [];
function timing(label: string, enabled: boolean) {
  globalThis.gc!();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    run(enabled);
  }
  const wallMs = performance.now() - start;
  const usage = process.threadCpuUsage(cpu);
  rows.push({
    label,
    enabled,
    iterations,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1_000,
    load: loadavg(),
  });
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + sampledBytes(child), 0);
}
async function allocation(label: string, enabled: boolean) {
  globalThis.gc!();
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < iterations; index++) {
    run(enabled);
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  rows.push({ label, enabled, iterations, sampledAllocatedBytes: sampledBytes(profile.head) });
}
try {
  for (let index = 0; index < 10_000; index++) {
    run(false);
    run(true);
  }
  timing("AA-1", false);
  timing("AA-2", false);
  for (let pair = 0; pair < 5; pair++) {
    for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      timing(`pair-${pair}`, enabled);
    }
  }
  await allocation("AA-1", false);
  await allocation("AA-2", false);
  for (let pair = 0; pair < 5; pair++) {
    for (const enabled of pair % 2 ? [true, false] : [false, true]) {
      await allocation(`pair-${pair}`, enabled);
    }
  }
  assert.equal(warningCount, 0, "Every measured transaction must stay below the slow threshold");
  assert.equal(db.prepare("SELECT count(*) AS count FROM entries").get()?.count, 1);
  const mapping = new Map<string, string>();
  const subscriber = (event: unknown) => {
    if (event && typeof event === "object" && "sql" in event && typeof event.sql === "string") {
      mapping.set(createHash("sha256").update(event.sql).digest("hex").slice(0, 16), event.sql);
    }
  };
  const statementChannel = channel("openclaw.database.statement");
  statementChannel.subscribe(subscriber);
  try {
    run(true);
  } finally {
    statementChannel.unsubscribe(subscriber);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        statementsPerTransaction: 16,
        labels,
        warningCount,
        acceptance:
          "Report absolute overhead and A/A spread; this is diagnostic cost, not a claimed optimization.",
        rows,
        syntheticStatementMapping: Object.fromEntries(mapping),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
