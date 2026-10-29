// Run from the revision under test:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-projection-stream-measure.ts \
//   --output .local/session-projection-timing.json
// Add --allocations for a separate 4 KiB collected-object sampling pass; sampled
// timing is diagnostic only. Six browser projection owners retain 199 completed
// runs and one active run each. After 1,000 warm-up deltas, measure 3,000 deltas
// round-robin through the public Gateway event reducer. --iterations and --retained
// vary those counts. Compare identical fixtures and Node versions, interleaving
// base/candidate runs. This is owner CPU/allocation proof, not browser/Gateway
// latency proof. Keep natural GC enabled and report absolute GC deltas.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  createSessionProjection,
  reduceSessionProjectionRunEvent,
  type SessionProjectionState,
} from "../../packages/gateway-client/src/session-projection.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "3000" },
    retained: { type: "string", default: "199" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const retained = parseStrictIntegerOption({
  raw: values.retained,
  label: "--retained",
  min: 0,
  fallback: 199,
});
assert(retained <= 199, "--retained must not exceed 199");
assert(global.gc, "Run with --expose-gc");
const sessions = 6;
const warmup = 1000;
const chunk = " next";
const baselineText = "Streaming reply";
const owners: SessionProjectionState[] = [];
for (let session = 0; session < sessions; session++) {
  let projection = createSessionProjection({ sessionKey: `agent:main:bench-${session}` });
  for (let run = 0; run < retained; run++) {
    const result = reduceSessionProjectionRunEvent(projection, {
      state: "final",
      runId: `completed-${run}`,
      seq: 1,
      message: { role: "assistant", content: "Completed synthetic reply." },
    });
    assert(result);
    projection = result.projection;
  }
  const active = reduceSessionProjectionRunEvent(projection, {
    state: "delta",
    runId: "active",
    seq: 1,
    message: { role: "assistant", content: [{ type: "text", text: baselineText }] },
  });
  assert(active);
  owners.push(active.projection);
}

function stream(count: number, sequenceOffset: number) {
  for (let index = 0; index < count; index++) {
    const session = index % sessions;
    const transition = reduceSessionProjectionRunEvent(owners[session]!, {
      state: "delta",
      runId: "active",
      seq: sequenceOffset + index,
      deltaText: chunk,
    });
    assert(transition);
    owners[session] = transition.projection;
  }
}

function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}

const inspector = new Session();
const collections: { startTime: number; duration: number; kind: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if ("detail" in entry) {
      // SAFETY: This observer subscribes only to Node GC entries, whose detail records kind.
      const detail = entry.detail as { kind: number };
      collections.push({ startTime: entry.startTime, duration: entry.duration, kind: detail.kind });
    }
  }
});
try {
  stream(warmup, 2);
  global.gc();
  await nextTurn();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const started = performance.now();
  stream(iterations, warmup + 2);
  const ended = performance.now();
  const threadCpu = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const loadAfter = loadavg();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const gc = collections.filter((entry) => entry.startTime >= started && entry.startTime < ended);
  const byKind: Record<number, { count: number; totalMs: number; maxMs: number }> = {};
  for (const entry of gc) {
    const kind = (byKind[entry.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    kind.count++;
    kind.totalMs += entry.duration;
    kind.maxMs = Math.max(kind.maxMs, entry.duration);
  }
  for (let session = 0; session < sessions; session++) {
    const count = (total: number) =>
      Math.floor(total / sessions) + (session < total % sessions ? 1 : 0);
    assert.equal(Object.keys(owners[session]!.runs).length, retained + 1);
    assert.deepEqual(owners[session]!.runs.active?.message, {
      role: "assistant",
      content: [
        { type: "text", text: baselineText + chunk.repeat(count(warmup) + count(iterations)) },
      ],
    });
  }
  const allocatedBytes = profile ? allocated(profile.head) : undefined;
  const elapsedMs = ended - started;
  // Compare retained heap outside timing, without retaining an allocation profile.
  if (!values.allocations) {
    global.gc();
  }
  const memoryAfterGc = values.allocations ? undefined : process.memoryUsage();
  const result = {
    node: process.version,
    mode: values.allocations ? "sampled-allocation" : "untraced-timing",
    sessions,
    retainedPerSession: retained,
    iterations,
    warmup,
    elapsedMs,
    cpu,
    cpuUsPerDelta: (cpu.user + cpu.system) / iterations,
    mainThreadCpuUsPerDelta: (threadCpu.user + threadCpu.system) / iterations,
    allocatedBytes,
    allocatedBytesPerDelta: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    gc: { count: gc.length, totalMs: gc.reduce((sum, entry) => sum + entry.duration, 0), byKind },
    memoryBefore,
    memoryAfter,
    memoryAfterGc,
    loadBefore,
    loadAfter,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, json);
  }
  process.stdout.write(json);
} finally {
  observer.disconnect();
  inspector.disconnect();
}
