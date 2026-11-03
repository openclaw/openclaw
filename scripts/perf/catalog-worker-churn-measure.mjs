/**
 * Synthetic catalog decoder idle-churn probe, using the real owner and a built worker.
 * node --import ./scripts/tsx.mjs scripts/perf/catalog-worker-churn-measure.mjs \
 *   --output .local/catalog/candidate.json --build-dir . --rounds 4 --gap-ms 61000
 * Baseline: add --owner-file <original client-catalog-worker.ts>; alternate AB/BA arms.
 * Each round projects 16 large previews, then runs --iterations (default 1000) warm pages.
 * One process/client, no provider or real data. Startup counters include first projection.
 * CPU/allocation counters are exact Node 26.12+ isolate counters; probes run after replies.
 * Residual RSS subtracts main and every live worker's heapTotal/external, not heapUsed.
 * Native memory is a residual, not a leak diagnosis. No forced collections in timed work.
 * This owner probe is not a whole-Gateway stress test; tails need adequate sample counts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import threads from "node:worker_threads";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "build-dir": { type: "string", default: process.cwd() },
    "owner-file": { type: "string" },
    rounds: { type: "string", default: "4" },
    "gap-ms": { type: "string", default: "61000" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.output);
const rounds = Number(values.rounds),
  gapMs = Number(values["gap-ms"]),
  iterations = Number(values.iterations);
assert(Number.isSafeInteger(rounds) && rounds > 1);
assert(Number.isSafeInteger(gapMs) && gapMs > 60000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL(
  "../../extensions/codex/src/app-server/client-catalog-worker.ts",
  import.meta.url,
);
const ownerSource = fs.readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
const workerFile = path.resolve(
  values["build-dir"],
  "dist/extensions/codex/catalog-page.worker.js",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workerHash = hash(fs.readFileSync(workerFile));
registerHooks({
  load(url, context, next) {
    return url === ownerUrl.href
      ? { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true }
      : next(url, context);
  },
});
const NativeWorker = threads.Worker;
const workers = [];
threads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const catalog = String(filename).endsWith("/catalog-page.worker.ts");
    super(
      catalog ? pathToFileURL(workerFile) : filename,
      catalog ? { ...options, execArgv: [] } : options,
    );
    if (catalog) {
      const record = { worker: this, exited: false, cpuMs: 0, allocatedBytes: 0 };
      workers.push(record);
      this.once("exit", () => {
        record.exited = true;
      });
    }
  }
};
syncBuiltinESMExports();
const { CodexCatalogWorker } = await import(ownerUrl.href);
const owner = new CodexCatalogWorker();
// Idle workers and their diagnostics are unref'ed; probes still need a live host.
const keepAlive = setInterval(() => {}, 1000);
const id = Number.MAX_SAFE_INTEGER - 2;
const route = { id, kind: "list" };
const attempts = new Map([[id, { catalogProjection: { remainingRows: 16 } }]]);
const page = JSON.stringify({
  id,
  result: {
    data: Array.from({ length: 16 }, (_, index) => ({
      id: `synthetic-${index}`,
      preview: "synthetic preview ".padEnd(65536, "x"),
    })),
    nextCursor: null,
  },
});
const warmPage = JSON.stringify({
  id,
  result: { data: [{ id: "warm" }], unused: "x".repeat(65536) },
});
const snapshots = [],
  latencies = [],
  startup = [],
  warm = [];
async function census(phase) {
  let heapTotal = 0,
    external = 0,
    heapUsed = 0;
  for (const record of workers) {
    if (record.exited) {
      continue;
    }
    const [heap, cpu] = await Promise.all([
      record.worker.getHeapStatistics(),
      record.worker.cpuUsage(),
    ]);
    record.cpuMs = (cpu.user + cpu.system) / 1000;
    record.allocatedBytes = heap.total_allocated_bytes;
    heapTotal += heap.total_heap_size;
    external += heap.external_memory;
    heapUsed += heap.used_heap_size;
  }
  const main = process.memoryUsage();
  const sample = {
    phase,
    atMs: performance.now() - started,
    workersStarted: workers.length,
    liveWorkers: workers.filter((w) => !w.exited).length,
    main,
    workerHeapTotal: heapTotal,
    workerHeapUsed: heapUsed,
    workerExternal: external,
    residualBytes: main.rss - main.heapTotal - main.external - heapTotal - external,
    hostLoad: loadavg(),
  };
  snapshots.push(sample);
  return sample;
}
async function decode(frame) {
  const at = performance.now();
  const decoded = await owner.decode(Buffer.from(frame), route, attempts);
  latencies.push(performance.now() - at);
  assert.equal(decoded.failures.length, 0);
  assert.equal(decoded.message.result.data[0].id, frame === page ? "synthetic-0" : "warm");
}
const mainStart = getHeapStatistics().total_allocated_bytes;
const cpuStart = process.cpuUsage(),
  mainCpuStart = process.threadCpuUsage(),
  started = performance.now();
const sum = (field) => workers.reduce((total, record) => total + record[field], 0);
try {
  await census("before");
  for (let round = 0; round < rounds; round++) {
    const before = workers.length;
    await decode(page);
    const first = await census(`round-${round}-first`);
    if (workers.length > before) {
      startup.push({ cpuMs: workers.at(-1).cpuMs, allocatedBytes: workers.at(-1).allocatedBytes });
    }
    const cpu = sum("cpuMs"),
      allocated = sum("allocatedBytes");
    for (let iteration = 0; iteration < iterations; iteration++) {
      await decode(warmPage);
    }
    await census(`round-${round}-warm`);
    warm.push({
      cpuMs: sum("cpuMs") - cpu,
      allocatedBytes: sum("allocatedBytes") - allocated,
      liveWorkers: first.liveWorkers,
    });
    if (round + 1 < rounds) {
      await delay(gapMs);
    }
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart),
    mainCpu = process.threadCpuUsage(mainCpuStart);
  const mainAllocatedBytes = getHeapStatistics().total_allocated_bytes - mainStart;
  await owner.close(new Error("synthetic probe complete"));
  await census("closed");
  fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  fs.writeFileSync(
    values.output,
    JSON.stringify(
      {
        node: process.version,
        ownerHash: hash(ownerSource),
        workerHash,
        rounds,
        gapMs,
        iterations,
        elapsedMs,
        workersStarted: workers.length,
        startsPerHour: (workers.length * 3600000) / elapsedMs,
        processCpuMs: (cpu.user + cpu.system) / 1000,
        mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
        mainAllocatedBytes,
        workerAllocatedBytes: sum("allocatedBytes"),
        workerCpuMs: sum("cpuMs"),
        startup,
        warm,
        latencies,
        snapshots,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await owner.close(new Error("probe cleanup"));
  } finally {
    clearInterval(keepAlive);
  }
}
