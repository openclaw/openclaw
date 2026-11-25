/**
 * Reuse usage-refresh-stats-measure.ts's synthetic fixture; never point at live data.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-hydration-read-measure.ts \
 *   --root /isolated/fixture --operation logs --cold --label A1
 * Run A1/A2 controls in separate processes; these are owner measurements, not Gateway latency.
 * Logs exercises the real async diagnostic loader and worker pool. Bounded/branches measure
 * the same SQL owners directly on a new admitted reader. Allocation includes the main isolate
 * only; process CPU and /proc/self/io include its workers. No native allocation claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { evictLinuxFilePageCache } from "../lib/linux-page-cache.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    operation: { type: "string", default: "logs" },
    session: { type: "string", default: "0" },
    limit: { type: "string", default: "1000" },
    cold: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    label: { type: "string", default: "A1" },
  },
});
assert(values.root, "--root is required");
assert(["logs", "summary", "bounded", "branches"].includes(values.operation));
assert(!values.cold || process.platform === "linux", "--cold requires Linux");
const root = path.resolve(values.root);
const fixture: { databasePath: string; sessions: number; shapes: { events: number }[] } =
  JSON.parse(readFileSync(path.join(root, "usage-refresh-stats-fixture.json"), "utf8"));
assert(path.resolve(fixture.databasePath).startsWith(root + path.sep));
const index = Number(values.session);
const limit = Number(values.limit);
assert(Number.isSafeInteger(index) && index >= 0 && index < fixture.sessions);
assert(Number.isSafeInteger(limit) && limit > 0);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
const { formatSqliteSessionFileMarker } =
  await import("../../src/config/sessions/legacy-sqlite-marker.js");
const { loadSessionLogs, loadSessionCostSummary } =
  await import("../../src/infra/session-cost-usage-reporting.js");
const { sampleTrackedWorkerMemory } = await import("../../src/infra/worker-cpu.js");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.js");
const { runSqliteReadSnapshotSync } = await import("../../src/infra/sqlite-transaction.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { readSessionTranscriptBoundedActiveContextCore } =
  await import("../../src/config/sessions/session-accessor.sqlite-active-context.js");
const { readSessionBranchSummaries } =
  await import("../../src/config/sessions/session-accessor.sqlite-branch-summaries.js");
const target = (selected: number) => {
  const sessionId = `synthetic-usage-${String(selected).padStart(5, "0")}`;
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: fixture.databasePath,
    path: fixture.databasePath,
  };
};
const logs = (selected: number) =>
  loadSessionLogs({
    agentId: "main",
    sessionId: target(selected).sessionId,
    sessionFile: formatSqliteSessionFileMarker(target(selected)),
    config: {},
    limit,
  });
const summary = () =>
  loadSessionCostSummary({
    agentId: "main",
    sessionId: target(index).sessionId,
    sessionFile: formatSqliteSessionFileMarker(target(index)),
    config: {},
  });
const processReadBytes = () => {
  if (process.platform !== "linux") {
    return undefined;
  }
  const match = /^read_bytes:\s*(\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"));
  assert(match);
  return Number(match[1]);
};
// Warm module loading, worker admission and pricing on a different, small session.
if (values.operation === "logs") {
  await logs(fixture.sessions - 1);
}
if (values.operation === "summary") {
  const { refreshCostUsageCacheForAgent } =
    await import("../../src/infra/session-cost-usage-aggregation.js");
  await refreshCostUsageCacheForAgent({
    agentId: "main",
    config: {},
    storePath: fixture.databasePath,
    databasePath: fixture.databasePath,
    sessionFiles: [formatSqliteSessionFileMarker(target(index))],
    waitForRefresh: true,
  });
  assert(await summary(), "Seed the selected session rollup before measurement");
}
if (values.cold) {
  for (const file of [fixture.databasePath, fixture.databasePath + "-wal"]) {
    if (!existsSync(file)) {
      continue;
    }
    evictLinuxFilePageCache(file);
  }
}
const db =
  values.operation === "logs" || values.operation === "summary"
    ? undefined
    : openNodeSqliteDatabase(fixture.databasePath, { readOnly: true });
if (db) {
  admitSqliteSchema(db);
}
const inspector = new Session();
global.gc?.();
if (values.allocation) {
  await startCollectedHeapSampling(inspector, 4096);
}
const beforeMetrics = sampleTrackedWorkerMemory({ refresh: false }).sqliteReaderMetrics;
const beforeBytes = processReadBytes();
const beforeCpu = process.cpuUsage();
const started = performance.now();
const result =
  values.operation === "logs"
    ? await logs(index)
    : values.operation === "summary"
      ? await summary()
      : values.operation === "bounded"
        ? runSqliteReadSnapshotSync(db!, () =>
            readSessionTranscriptBoundedActiveContextCore(target(index), {
              maxEvents: 50,
              maxBytes: 1024 * 1024,
              transaction: { agentId: "main", path: fixture.databasePath, db: db! },
              resolvedScope: target(index),
            }),
          )
        : runSqliteReadSnapshotSync(db!, () =>
            readSessionBranchSummaries({ db: db! }, target(index).sessionId),
          );
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(beforeCpu);
const afterBytes = processReadBytes();
const readerMetrics = sampleTrackedWorkerMemory({ refresh: false })
  .sqliteReaderMetrics.map((entry) => {
    const prior = beforeMetrics.find((value) => value.operation === entry.operation);
    return {
      operation: entry.operation,
      count: entry.count - (prior?.count ?? 0),
      readBytes: entry.readBytes - (prior?.readBytes ?? 0),
    };
  })
  .filter((entry) => entry.count || entry.readBytes)
  .toSorted((a, b) => b.readBytes - a.readBytes);
let mainAllocatedBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  mainAllocatedBytes = sumSampledHeapBytes(profile.head);
  inspector.disconnect();
}
if (values.operation === "logs") {
  assert(
    Array.isArray(result) && result.length === Math.min(limit, fixture.shapes[index]!.events - 1),
  );
}
if (values.operation === "summary") {
  assert(result && "totalTokens" in result);
  assert.equal(result.totalTokens, Math.floor((fixture.shapes[index]!.events - 1) / 2) * 125);
}
console.log(
  JSON.stringify({
    operation: values.operation,
    label: values.label,
    session: index,
    cold: values.cold,
    databaseBytes: statSync(fixture.databasePath).size,
    selectedEvents: fixture.shapes[index]!.events,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainAllocatedBytes,
    readBytes:
      beforeBytes === undefined || afterBytes === undefined ? undefined : afterBytes - beforeBytes,
    readerMetrics,
    digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    loadavg: loadavg(),
    platform: process.platform,
    node: process.version,
  }),
);
db?.close();
await closeOpenClawAgentDatabasesAsync();
