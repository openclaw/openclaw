/**
 * Measure the real Gateway cron projection or tool-progress snapshot owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/gateway-snapshot-freeze-measure.mjs \
 *   --root . --workload cron --mode timing --operations 2000
 * Repeat with --workload progress and --mode allocation in separate processes.
 * --root selects a source checkout. --cron-subject / --progress-subject select
 * preserved baseline modules beside their originals (relative imports unchanged).
 * Use the same tooling and fixtures for both
 * revisions, five counterbalanced serial pairs, and A/A controls before calling
 * a GC/tail change adverse. Set TMPDIR to the lane's isolated scratch directory.
 *
 * Cron: 10,000 owner-frozen jobs, rotating 200-row pages, alternating full/compact
 * presentation; each request changes the page and misses the presentation cache.
 * Progress: fresh snapshots of tool results with 32 nested records and arrays.
 * Setup/imports are excluded. Timing is untraced; allocation sampling includes
 * collected objects and must not be used for timing decisions. Accept preserved
 * output/isolation and less CPU or allocation under the lane's decision rules.
 * This is an owner microbenchmark, not whole-Gateway throughput evidence.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    workload: { type: "string", default: "cron" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "2000" },
    "cron-subject": { type: "string" },
    "progress-subject": { type: "string" },
  },
});
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(["cron", "progress"].includes(values.workload));
assert(["timing", "allocation"].includes(values.mode));
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")));
const root = path.resolve(values.root);
const state = await mkdtemp(path.join(tmpdir(), "gateway-snapshot-measure-"));
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_HOME = state;
process.env.OPENCLAW_CONFIG_PATH = path.join(state, "openclaw.json");
const source = (file) => import(pathToFileURL(path.resolve(root, file)).href);
try {
  let run;
  let verify;
  if (values.workload === "cron") {
    const { freezeJsonSnapshot } = await source("src/shared/immutable-data.ts");
    const { projectCronListJobs } = await source(
      values["cron-subject"] ?? "src/gateway/server-methods/cron-list-projection.ts",
    );
    const jobs = Array.from({ length: 10_000 }, (_, index) =>
      freezeJsonSnapshot({
        id: `synthetic-${index}`,
        name: `Synthetic job ${index}`,
        enabled: true,
        createdAtMs: 1_800_000_000_000,
        updatedAtMs: 1_800_000_000_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "synthetic 🦞 job ".repeat(64) },
        delivery: { mode: "none" },
        state: { nextRunAtMs: 1_800_000_060_000 + index, lastRunStatus: "ok" },
      }),
    );
    const pages = Array.from({ length: 50 }, (_, index) => ({
      jobs: jobs.slice(index * 200, (index + 1) * 200),
      snapshotRevision: "synthetic-revision",
      total: jobs.length,
      offset: index * 200,
      limit: 200,
      hasMore: index < 49,
      nextOffset: index < 49 ? (index + 1) * 200 : null,
    }));
    const owner = { getDefaultAgentId: () => "synthetic" };
    run = (index) => projectCronListJobs(owner, pages[index % pages.length], index % 2 === 1);
    verify = () => {
      const full = run(0);
      const compact = run(1);
      assert.equal(full.length, 200);
      assert.equal(compact.length, 200);
      assert.equal(full[0].effectiveAgentId, "synthetic");
      assert.equal(compact[0].id, "synthetic-200");
      assert(Object.isFrozen(full));
      assert(Object.isFrozen(full[0]));
      assert(Object.isFrozen(full[0].state));
      assert(Object.isFrozen(compact[0].schedule));
      assert.equal(Reflect.set(full[0].state, "nextRunAtMs", 0), false);
      assert.equal(full[0].state.nextRunAtMs, 1_800_000_060_000);
      return 200;
    };
  } else {
    const { updateChatRunProgressSnapshot } = await source(
      values["progress-subject"] ?? "src/gateway/server-chat-progress-snapshot.ts",
    );
    const result = {
      content: Array.from({ length: 32 }, (_, index) => ({
        type: "text",
        text: `Synthetic result ${index}: ${"text 🦞 ".repeat(24)}`,
        details: { path: `fixture-${index}.ts`, lines: [index, index + 1], found: true },
      })),
    };
    run = (index) =>
      updateChatRunProgressSnapshot(undefined, {
        runId: `synthetic-${index % 10_000}`,
        seq: index + 1,
        stream: "tool",
        ts: 1_800_000_000_000,
        data: { phase: "result", name: "read", toolCallId: "synthetic-tool", result },
      });
    verify = () => {
      const snapshot = run(0);
      const captured = snapshot.events[0];
      assert.deepEqual(captured.data.result, result);
      assert.notEqual(captured.data.result, result);
      assert.equal(snapshot.byteLength, Buffer.byteLength(JSON.stringify(captured)));
      assert(Object.isFrozen(captured.data.result.content[0].details.lines));
      assert.equal(Reflect.set(captured.data.result.content[0], "text", "changed"), false);
      return 1;
    };
  }
  const recordsPerOperation = verify();
  for (let index = 0; index < 100; index++) {
    run(index);
  }
  global.gc?.();
  await nextTurn();
  const profiler = values.mode === "allocation" ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const pauses = [];
  const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const memoryBefore = process.memoryUsage();
  const hostLoadBefore = loadavg();
  const latencies = [];
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  let last;
  for (let index = 0; index < operations; index++) {
    const begin = performance.now();
    last = run(index);
    latencies.push(performance.now() - begin);
    if (index % 32 === 31) {
      await nextTurn();
    }
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  pauses.push(...observer.takeRecords());
  observer.disconnect();
  let allocatedBytes;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    profiler.disconnect();
  }
  assert(last);
  verify();
  const summarize = (samples) => {
    const sorted = samples.toSorted((a, b) => a - b);
    const at = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    return {
      count: sorted.length,
      totalMs: sorted.reduce((sum, value) => sum + value, 0),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      maxMs: sorted.at(-1) ?? 0,
    };
  };
  console.log(
    JSON.stringify({
      root,
      subject:
        values.workload === "cron"
          ? (values["cron-subject"] ?? "src/gateway/server-methods/cron-list-projection.ts")
          : (values["progress-subject"] ?? "src/gateway/server-chat-progress-snapshot.ts"),
      workload: values.workload,
      mode: values.mode,
      operations,
      recordsPerOperation,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerOperation: (cpu.user + cpu.system) / operations,
      allocatedBytes,
      allocatedBytesPerOperation:
        allocatedBytes === undefined ? undefined : allocatedBytes / operations,
      latency: summarize(latencies),
      gc: summarize(pauses.map((entry) => entry.duration)),
      gcByKind: Object.fromEntries(
        [...new Set(pauses.map((entry) => entry.detail.kind))].map((kind) => [
          kind,
          summarize(
            pauses.filter((entry) => entry.detail.kind === kind).map((entry) => entry.duration),
          ),
        ]),
      ),
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  await rm(state, { recursive: true, force: true });
}
