/**
 * Measure validator retention through real AsyncResources after N and 2N calls.
 * Run unchanged on base and candidate, in separate processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/run-tool-validation-retention.ts
 *   --iterations 2000 [--allocations]
 * Each call captures 40 synthetic tools and an 8 KiB continuation. AsyncResources
 * remain alive like keep-alive sockets; no callback deliberately retains the run.
 * Timing is untraced; use --allocations for a separate allocation-sampling pass.
 * This owner measurement includes fixture creation, not whole-Gateway traffic.
 */
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  runWithToolExecutionValidation,
  validateToolExecutionParams,
} from "../../src/agents/agent-tools.execution-validation.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
const resources: AsyncResource[] = [];
const attempts: WeakRef<object>[] = [];
const tools: WeakRef<object>[] = [];
const validators: WeakRef<object>[] = [];

async function collect() {
  const control = new WeakRef({});
  for (let pass = 0; pass < 4; pass++) {
    await setImmediate();
    globalThis.gc!();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
}

async function invoke(index: number, retain: boolean) {
  const attempt = {
    continuation: Array.from({ length: 1024 }, (_, offset) => index + offset),
    tools: Array.from({ length: 40 }, (_, tool) => ({
      name: `synthetic_${tool}`,
      parameters: { type: "object", properties: {} },
    })),
  };
  const validator = (input: unknown) => {
    assert.equal(input, attempt.continuation[0]);
    assert.equal(attempt.tools.length, 40);
  };
  if (retain) {
    attempts.push(new WeakRef(attempt));
    validators.push(new WeakRef(validator));
    for (const tool of attempt.tools) {
      tools.push(new WeakRef(tool));
    }
  }
  await runWithToolExecutionValidation(String(index), validator, async () => {
    const resource = new AsyncResource("synthetic-keep-alive");
    if (retain) {
      resources.push(resource);
    } else {
      resource.emitDestroy();
    }
    await validateToolExecutionParams(String(index), index);
  });
}

function live(references: WeakRef<object>[]) {
  return references.reduce(
    (count, reference) => count + Number(reference.deref() !== undefined),
    0,
  );
}

const inspector = values.allocations ? new Session() : undefined;
inspector?.connect();
for (let index = 0; index < 100; index++) {
  await invoke(index, false);
}
await collect();
const initialHeap = process.memoryUsage().heapUsed;
const rows = [];
try {
  for (let phase = 0; phase < 2; phase++) {
    if (inspector) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadStart = loadavg();
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    for (let index = phase * iterations; index < (phase + 1) * iterations; index++) {
      await invoke(index, true);
    }
    const elapsedMs = performance.now() - start;
    const cpu = process.threadCpuUsage(cpuStart);
    let allocatedBytes: number | undefined;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node: typeof profile.head): number =>
        node.selfSize + node.children.reduce((bytes, child) => bytes + sum(child), 0);
      allocatedBytes = sum(profile.head);
    }
    await collect();
    const memory = process.memoryUsage();
    rows.push({
      completedCalls: (phase + 1) * iterations,
      measuredCalls: iterations,
      retainedAsyncResources: resources.length,
      liveAttempts: live(attempts),
      liveTools: live(tools),
      liveValidators: live(validators),
      heapUsedBytes: memory.heapUsed,
      heapGrowthBytes: memory.heapUsed - initialHeap,
      rssBytes: memory.rss,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      cpuMicrosecondsPerCall: (cpu.user + cpu.system) / iterations,
      allocatedBytes,
      allocatedBytesPerCall: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      hostLoadStart,
      hostLoadEnd: loadavg(),
    });
    // WeakRef.deref keeps targets alive to the next job; end it before another phase.
    await setImmediate();
  }
  process.stdout.write(
    JSON.stringify({ mode: values.allocations ? "allocation" : "timing", rows }, null, 2) + "\n",
  );
} finally {
  inspector?.disconnect();
  for (const resource of resources) {
    resource.emitDestroy();
  }
}
