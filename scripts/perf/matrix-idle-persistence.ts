/**
 * Measure unchanged Matrix crypto persistence through the real plugin-state writer.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/matrix-idle-persistence.ts \
 *   --state-dir .local/matrix-idle-base --iterations 1000 [--allocation]
 * Run the same script on base/candidate, then swap order. Each operation is one
 * account's 60-second persistence tick; four isolated account namespaces rotate.
 * Fixtures contain synthetic 48 KiB crypto records (three SQLite chunks/account).
 * Warmup/setup/cleanup are excluded; sampled allocations include collected objects.
 * CPU is untraced main-thread CPU; traced timings are context only. This is owner
 * evidence, not a Gateway load test. No server or external Matrix account is used.
 * Acceptance: zero writers for unchanged ticks, durable changed data and orphan
 * cleanup retained, lower CPU/allocation per tick in both counterbalanced pairs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { persistIdbToDisk } from "../../extensions/matrix/src/matrix/sdk/idb-persistence.js";
import {
  clearAllIndexedDbState,
  seedDatabase,
} from "../../extensions/matrix/src/matrix/sdk/idb-persistence.test-helpers.js";
import { onWorkerRequestMetrics } from "../../src/infra/worker-request-diagnostics.js";
import { createPluginStateKeyedStoreV2 } from "../../src/plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "1000" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && global.gc, "Pass --state-dir and run with --expose-gc");
const root = path.resolve(values["state-dir"]);
assert(!existsSync(root), "State directory must not exist");
mkdirSync(root, { recursive: true });
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 1000,
});
const lifetime = new AbortController();
const stateRuntime = {
  openKeyedStoreV2: <T>(options: Parameters<typeof createPluginStateKeyedStoreV2<T>>[1]) =>
    createPluginStateKeyedStoreV2<T>("matrix", options, {
      assertCurrent: () => lifetime.signal.throwIfAborted(),
    }),
};
const accounts = Array.from({ length: 4 }, (_, index) => ({
  snapshotPath: path.join(root, `account-${index}`, "crypto-idb-snapshot.json"),
  databasePrefix: `synthetic-idle-${index}`,
  stateRuntime,
  strict: true,
}));
const inspector = new Session();
const counts: Record<string, number> = {};
let measured = false;
const unsubscribe = onWorkerRequestMetrics((kind, requestClass, phase) => {
  if (measured && kind === "sqlite_writer" && phase === "queued") {
    counts[requestClass] = (counts[requestClass] ?? 0) + 1;
  }
});
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
try {
  for (const account of accounts) {
    await seedDatabase({
      name: `${account.databasePrefix}::crypto`,
      storeName: "sessions",
      records: [{ key: "synthetic-room", value: { session: "x".repeat(48_000) } }],
    });
    await persistIdbToDisk(account);
  }
  for (let index = 0; index < 12; index++) {
    await persistIdbToDisk(accounts[index % accounts.length]);
  }
  global.gc();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const beforeMemory = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  measured = true;
  for (let index = 0; index < iterations; index++) {
    await persistIdbToDisk(accounts[index % accounts.length]);
  }
  measured = false;
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const profile = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      iterations,
      accounts: accounts.length,
      mode: values.allocation ? "allocation" : "timing",
      elapsedMs,
      mainThreadCpuUsPerTick: (used.user + used.system) / iterations,
      allocatedBytesPerTick: profile ? allocated(profile.head) / iterations : undefined,
      writerRequests: counts,
      writerRequestsPerSimulatedMinute: Object.fromEntries(
        Object.entries(counts).map(([key, count]) => [key, (count * accounts.length) / iterations]),
      ),
      beforeMemory,
      afterMemory: process.memoryUsage(),
      hostLoad,
    }),
  );
} finally {
  unsubscribe();
  lifetime.abort();
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
  for (const account of accounts) {
    await clearAllIndexedDbState({ databasePrefix: account.databasePrefix });
  }
  rmSync(root, { recursive: true });
}
