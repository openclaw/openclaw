/**
 * State-read setup/empty-close owner microbenchmark. Run the same script on each
 * revision, alternating base/candidate order, with an untraced CPU pass and a
 * separate allocation pass (never compare allocation-pass timings):
 *
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/state-read-transport-bench.ts --iterations 10000
 * Add --allocations for sampled allocation, including objects collected by GC.
 * --owner <absolute source module path> selects another prepared revision.
 *
 * This measures the per-read machinery only, using the real source capture,
 * transport creation and cleanup. The backup command has no variable payload;
 * database size cannot affect this setup. No tasks, workers, SQL, model turns or
 * Gateway requests run. Lifecycle tests must separately prove read semantics.
 * Function-identity counts run outside measurement and expose repeated closure
 * construction without retaining benchmark objects during allocation sampling.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { availableParallelism, hostname, loadavg } from "node:os";
import { resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { captureOpenClawStateReadSource } from "../../src/state/openclaw-state-read-worker.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "10000" },
    warmup: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 10000,
});
const warmup = parseStrictIntegerOption({
  raw: values.warmup,
  label: "--warmup",
  min: 1,
  fallback: 2000,
});
assert(global.gc, "Run with --expose-gc");
const ownerUrl = values.owner
  ? pathToFileURL(resolve(values.owner))
  : new URL("../../src/state/openclaw-state-read-worker.ts", import.meta.url);
const ownerSourceSha256 = createHash("sha256").update(readFileSync(ownerUrl)).digest("hex");
const { captureOpenClawStateReadSource: captureSource } = (await import(ownerUrl.href)) as {
  captureOpenClawStateReadSource: typeof captureOpenClawStateReadSource;
};
const command = { type: "backup.runs" } as const;

async function setup(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const source = captureSource();
    const transport = source.createTransport(command);
    await transport.startClose();
  }
}

async function countFunctions(count: number) {
  const createTransport = new Set();
  const startRead = new Set();
  const startValidateFresh = new Set();
  const startClose = new Set();
  for (let index = 0; index < count; index++) {
    const source = captureSource();
    const transport = source.createTransport(command);
    createTransport.add(source.createTransport);
    startRead.add(transport.startRead);
    startValidateFresh.add(transport.startValidateFresh);
    startClose.add(transport.startClose);
    await transport.startClose();
  }
  return {
    operations: count,
    createTransport: createTransport.size,
    startRead: startRead.size,
    startValidateFresh: startValidateFresh.size,
    startClose: startClose.size,
  };
}

function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}

const functionIdentities = await countFunctions(100);
await setup(warmup);
global.gc();
await nextTurn();
const loadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const inspector = new Session();
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  await setup(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const allocatedBytes = profile ? allocated(profile.head) : undefined;
  console.log(
    JSON.stringify({
      workload: "state read source capture, transport setup and empty close; no read dispatch",
      ownerSourceSha256,
      host: hostname(),
      node: process.version,
      availableParallelism: availableParallelism(),
      loadBefore,
      loadAfter: loadavg(),
      iterations,
      warmup,
      allocationSampling: values.allocations,
      functionIdentities,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      mainThreadCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      allocatedBytes,
      allocatedBytesPerOperation:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
}
