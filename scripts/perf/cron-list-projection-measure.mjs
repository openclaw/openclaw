/**
 * Real cron public projection owner, with 10,000 synthetic immutable jobs and
 * rotating 200-row overlapping pages. Both full and compact modes are warmed.
 * This isolates projection work after live filtering, not Gateway throughput.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-list-projection-measure.mjs \
 *   --mode timing --operations 2000 --output .local/cron-projection/candidate.json
 * --owner selects a baseline projection module whose imports resolve here.
 * Run alternating base/candidate arms, then separate --mode allocation passes.
 * --mode counts reports new row identities after warmup, outside timing passes.
 * --workload list-page rechecks the unchanged scheduler snapshot owner; counts
 * reports its clone/hash calls. No Gateway, timer, model, or SQLite write starts.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    workload: { type: "string", default: "projection" },
    owner: { type: "string" },
    operations: { type: "string", default: "2000" },
    output: { type: "string" },
  },
});
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(["projection", "list-page"].includes(values.workload));
assert(values.output, "--output is required");
assert(global.gc, "Run with --expose-gc");
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced timing");
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "--operations",
  min: 1,
  fallback: 2000,
});
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const stateDir = await mkdtemp(path.join(path.dirname(output), "synthetic-state-"));
const configPath = path.join(stateDir, "openclaw.json");
await writeFile(
  configPath,
  JSON.stringify({ agents: { entries: { main: {} } }, plugins: { enabled: false } }),
);
process.env = {
  ...createGatewayBenchEnv(stateDir, configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: stateDir,
};
const ownerUrl = values.owner
  ? pathToFileURL(path.resolve(values.owner))
  : new URL(
      values.workload === "list-page"
        ? "../../src/cron/service/ops-read.ts"
        : "../../src/gateway/server-methods/cron-list-projection.ts",
      import.meta.url,
    );
const ownerSha256 = crypto
  .createHash("sha256")
  .update(await readFile(ownerUrl))
  .digest("hex");
const { projectCronListJobs, listPage } = await import(ownerUrl.href);
const { freezeJsonSnapshot } = await import("../../src/shared/immutable-data.ts");
const cron = { getDefaultAgentId: () => "main" };
const jobs = Array.from({ length: 10_000 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic report ${index}`,
  description: "Synthetic scheduled report. ".repeat(4),
  enabled: index % 5 !== 0,
  agentId: index % 3 === 0 ? "ops" : undefined,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Synthetic owner benchmark message. ".repeat(16) },
  delivery: { mode: "none" },
  state: { nextRunAtMs: 1_800_000_060_000 + index, lastStatus: "ok", lastDurationMs: 12 },
}));
let state;
let readPage;
if (values.workload === "list-page") {
  const { createCronServiceState } = await import("../../src/cron/service/state.ts");
  const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.ts");
  state = createCronServiceState({
    scheduler: new GatewayScheduler(),
    storePath: path.join(stateDir, "cron", "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    nowMs: () => 1_800_000_000_000,
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  state.store = { version: 1, jobs };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.schedulerStarted = true;
  readPage = async (index) =>
    (
      await listPage(state, {
        includeDisabled: true,
        limit: 200,
        offset: (index % 2) * 100,
        sortBy: "name",
      })
    ).jobs;
}
const frozen = jobs.map((job) => freezeJsonSnapshot(structuredClone(job)));
const pages = Array.from({ length: 100 }, (_, index) => {
  const offset = index * 100;
  const selected = frozen.slice(offset, offset + 200);
  return {
    jobs: selected,
    snapshotRevision: "synthetic-current-read",
    total: jobs.length,
    offset,
    limit: 200,
    hasMore: offset + selected.length < jobs.length,
    nextOffset: offset + selected.length < jobs.length ? offset + selected.length : null,
  };
});
const seen = new WeakSet();
let newRows = 0;
let cloneCalls = 0;
let hashCalls = 0;
let checksum = 0;
const originalClone = globalThis.structuredClone;
const originalHash = crypto.createHash;
const inspector = new Session();
const run = async (index, countRows = false) => {
  const result = readPage
    ? await readPage(index)
    : projectCronListJobs(
        cron,
        pages[index % pages.length],
        Math.floor(index / pages.length) % 2 === 1,
      );
  checksum += result.length;
  if (countRows) {
    for (const row of result) {
      if (!seen.has(row)) {
        newRows++;
        seen.add(row);
      }
    }
  }
  return result;
};
try {
  global.gc();
  await nextTurn();
  const fixtureMemory = process.memoryUsage();
  const wireHash = crypto.createHash("sha256");
  for (let index = 0; index < 200; index++) {
    wireHash.update(JSON.stringify(await run(index, values.mode === "counts")));
  }
  const wireSha256 = wireHash.digest("hex");
  const warmupNewRows = newRows;
  newRows = 0;
  checksum = 0;
  const snapshot = state?.readSnapshot;
  global.gc();
  await nextTurn();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (values.mode === "counts") {
    globalThis.structuredClone = (value, options) => {
      cloneCalls++;
      return originalClone(value, options);
    };
    crypto.createHash = (...args) => {
      hashCalls++;
      return originalHash(...args);
    };
    syncBuiltinESMExports();
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage?.();
  const start = performance.now();
  for (let index = 0; index < operations; index++) {
    await run(index, values.mode === "counts");
  }
  const elapsed = performance.now() - start;
  const cpuUsed = process.cpuUsage(cpu);
  const threadUsed = thread && process.threadCpuUsage(thread);
  const memoryAfter = process.memoryUsage();
  globalThis.structuredClone = originalClone;
  crypto.createHash = originalHash;
  syncBuiltinESMExports();
  const profile =
    values.mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
  global.gc();
  await nextTurn();
  const memoryAfterGc = process.memoryUsage();
  assert(checksum > 0);
  if (values.workload === "list-page") {
    assert.equal(state.readSnapshot, snapshot);
  }
  const result = await run(0);
  assert(Object.isFrozen(result[0]));
  const sampledBytes = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
  const report = {
    workload: values.workload,
    mode: values.mode,
    node: process.version,
    owner: ownerUrl.href,
    ownerSha256,
    wireSha256,
    jobs: jobs.length,
    pages: pages.length,
    pageLimit: 200,
    operations,
    warmup: 200,
    hostLoad,
    wallUsPerOperation: (elapsed * 1000) / operations,
    processCpuUsPerOperation: (cpuUsed.user + cpuUsed.system) / operations,
    threadCpuUsPerOperation: threadUsed ? (threadUsed.user + threadUsed.system) / operations : null,
    memory: {
      fixture: fixtureMemory,
      before: memoryBefore,
      after: memoryAfter,
      afterGc: memoryAfterGc,
    },
    allocation: profile
      ? {
          sampledBytes: sampledBytes(profile.head),
          bytesPerOperation: sampledBytes(profile.head) / operations,
        }
      : null,
    counts: values.mode === "counts" ? { warmupNewRows, newRows, cloneCalls, hashCalls } : null,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  globalThis.structuredClone = originalClone;
  crypto.createHash = originalHash;
  syncBuiltinESMExports();
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  await rm(stateDir, { recursive: true, force: true });
}
