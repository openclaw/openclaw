// Synthetic owner-boundary admission workload. No Gateway, disk state, or operator data.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/command-lane-wait-measure.ts --output <path> [--allocations]
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../src/process/command-queue.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
    waves: { type: "string", default: "32" },
  },
});
assert(values.output);
assert(globalThis.gc, "Use --expose-gc");
const waves = Number(values.waves);
assert(Number.isInteger(waves) && waves > 0);
const lane = "synthetic-main";
setCommandLaneConcurrency(lane, 32);
const inspector = new Session();
let attributedWaits = 0;
let completed = 0;
const samples: number[] = [];
const hostLoad = loadavg();
async function wave(index: number) {
  const gate = Promise.withResolvers<void>();
  const started = performance.now();
  const tasks = Array.from({ length: 128 }, (_, slot) =>
    enqueueCommandInLane(
      lane,
      async () => {
        await gate.promise;
        completed++;
      },
      {
        taskIdentity: {
          taskKind: "turn",
          sessionKey: `agent:fixture:session-${index * 128 + slot}`,
          runId: `run-${index * 128 + slot}`,
        },
        warnAfterMs: Number.POSITIVE_INFINITY,
        onQueued(wait) {
          if (wait) {
            attributedWaits++;
          }
        },
      },
    ),
  );
  assert.equal(getCommandLaneSnapshot(lane).activeCount, 32);
  assert.equal(getCommandLaneSnapshot(lane).queuedCount, 96);
  gate.resolve();
  await Promise.all(tasks);
  assert.equal(getCommandLaneSnapshot(lane).activeCount, 0);
  return performance.now() - started;
}
await wave(-1);
completed = 0;
attributedWaits = 0;
globalThis.gc();
if (values.allocations) {
  await startCollectedHeapSampling(inspector, 4096);
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
const cpu = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < waves; index++) {
  samples.push(await wave(index));
}
const elapsedMs = performance.now() - started;
const usedCpu = process.cpuUsage(cpu);
const heap = values.allocations
  ? (await inspector.post("HeapProfiler.stopSampling")).profile
  : undefined;
if (values.allocations) {
  const { profile } = await inspector.post("Profiler.stop");
  await writeFile(`${values.output}.cpuprofile`, JSON.stringify(profile));
  await writeFile(`${values.output}.heapprofile`, JSON.stringify(heap));
  inspector.disconnect();
}
await writeFile(
  values.output,
  JSON.stringify(
    {
      scope:
        "Queue admission and release only; 32 holders and 96 waiters per wave. Session DB and workspace size cannot affect this in-memory owner.",
      waves,
      sessions: waves * 128,
      completed,
      attributedWaits,
      expectedWaits: waves * 96,
      elapsedMs,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      sampledAllocationBytes: heap ? sumSampledHeapBytes(heap.head) : undefined,
      samples,
      hostLoad,
      endLoad: loadavg(),
    },
    null,
    2,
  ),
);
