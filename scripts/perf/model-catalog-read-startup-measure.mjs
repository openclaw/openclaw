// Measure cold persisted-catalog worker module evaluation in an already-built revision:
// node scripts/perf/model-catalog-read-startup-measure.mjs --samples 10 --output <json>
// Run base/candidate in alternating order, without concurrent builds. Each sample is a
// fresh worker; this measures import CPU/allocation, not steady-state query throughput.
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      entry: { type: "string", default: "dist/agents/plugin-model-catalog-read.worker.js" },
      samples: { type: "string", default: "10" },
      output: { type: "string" },
    },
  });
  const count = Number(values.samples);
  assert(Number.isSafeInteger(count) && count > 0);
  assert(values.output, "--output is required");
  const samples = [];
  for (let index = 0; index < count; index++) {
    const hostLoadBefore = loadavg();
    const started = performance.now();
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        entry: pathToFileURL(path.resolve(values.entry)).href,
        pluginCatalogRead: true,
      },
    });
    try {
      const [measurement] = await once(worker, "message");
      samples.push({
        ...measurement,
        spawnToImportedMs: performance.now() - started,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      });
    } finally {
      await worker.terminate();
    }
    writeFileSync(values.output, JSON.stringify({ entry: values.entry, samples }, null, 2));
    console.log(JSON.stringify(samples.at(-1)));
  }
} else {
  const before = getHeapStatistics();
  assert(Number.isFinite(before.total_allocated_bytes), "Node 26.12+ allocation counter required");
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await import(workerData.entry);
  const elapsedMs = performance.now() - started;
  const consumed = process.threadCpuUsage(cpu);
  const after = getHeapStatistics();
  parentPort.postMessage(
    {
      importMs: elapsedMs,
      cpuMs: (consumed.user + consumed.system) / 1000,
      allocatedBytes: after.total_allocated_bytes - before.total_allocated_bytes,
      heapUsedBytes: after.used_heap_size,
    },
    [],
  );
}
