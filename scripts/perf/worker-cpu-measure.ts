import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import { createCpuTrackedWorker, getTrackedWorkerCpuSources } from "../../src/infra/worker-cpu.ts";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    workers: { type: "string", default: "50" },
    batches: { type: "string", default: "2000" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const workerCount = integer(values.workers, "--workers");
const batches = integer(values.batches, "--batches");
const yieldMs = integer(values["yield-ms"], "--yield-ms", 0);
const startAt = integer(values["start-at"], "--start-at", 0);
assert.ok(values.output, "--output is required");
// Reserve both artifacts before starting workers or replacing either file.
writeFileSync(values.output, "", { flag: "wx" });
if (values.allocations) {
  writeFileSync(`${values.output}.heapprofile`, "", { flag: "wx" });
}
const workers: Worker[] = [];
const sources: ReturnType<typeof getTrackedWorkerCpuSources>["workers"] = [];
const inspector = values.allocations ? new Session() : undefined;
try {
  for (let index = 0; index < workerCount; index++) {
    workers.push(createCpuTrackedWorker("setInterval(() => {}, 60_000)", { eval: true }));
    // The factory registers synchronously; exclude unrelated loader threads.
    sources.push(getTrackedWorkerCpuSources().workers.at(-1)!);
  }
  await Promise.all(workers.map((worker) => once(worker, "online")));
  assert.equal(sources.length, workerCount);
  const sample = () => Promise.all(sources.map((worker) => worker.cpuUsage()));
  for (let index = 0; index < 100; index++) {
    await sample();
  }
  console.log("WORKER_CPU_READY");
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed synchronized start after warmup");
    await delay(startAt - Date.now());
  }
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 8192,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  console.log("WORKER_CPU_START");
  const stopDiagnostics = startGatewayBenchDiagnostics();
  const cpu = process.cpuUsage();
  const mainCpu = process.threadCpuUsage();
  const latency: number[] = [];
  let unavailable = 0;
  for (let index = 0; index < batches; index++) {
    const started = performance.now();
    const usage = await sample();
    latency.push(performance.now() - started);
    for (const counter of usage) {
      if (!counter) {
        unavailable++;
      }
    }
    if (yieldMs) {
      await delay(yieldMs);
    }
  }
  const mainUsed = process.threadCpuUsage(mainCpu);
  const used = process.cpuUsage(cpu);
  const diagnostics = stopDiagnostics();
  console.log("WORKER_CPU_END");
  let allocatedBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
    allocatedBytes = 0;
    const pending = [profile.head];
    for (const node of pending) {
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
  }
  assert.equal(unavailable, 0, "Native CPU counter failures invalidate this measurement");
  latency.sort((left, right) => left - right);
  const result = {
    workers: workerCount,
    batches,
    yieldMs,
    allocations: values.allocations,
    load: loadavg(),
    allocatedBytes,
    allocatedBytesPerBatch: allocatedBytes === undefined ? undefined : allocatedBytes / batches,
    cpuMsPerBatch: (used.user + used.system) / 1_000 / batches,
    mainCpuMsPerBatch: (mainUsed.user + mainUsed.system) / 1_000 / batches,
    latency: {
      count: latency.length,
      p50Ms: latency[Math.ceil(latency.length * 0.5) - 1],
      p95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
      p99Ms: latency[Math.ceil(latency.length * 0.99) - 1],
      maxMs: latency.at(-1),
    },
    diagnostics,
  };
  writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
  await Promise.all(workers.map((worker) => worker.terminate()));
}
