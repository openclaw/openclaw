/**
 * Trusted snapshot owner cost, including a replica-style republished participant
 * array with one new tail, fresh decoded entries, and retained-root cache hits.
 * node --expose-gc scripts/perf/trusted-snapshot-freeze-measure.mjs \
 *   --owner ./src/shared/immutable-data.ts --mode timing --operations 5000
 * Repeat base/candidate then candidate/base, five times; repeat --mode allocation
 * separately (collected allocations included). Use unchanged tooling in both arms.
 * Accept less allocation/CPU with identical deep immutability, cycle handling,
 * and identity. Fresh decode must not regress. This measures the freezer, not RPC
 * latency or whole-Gateway throughput. Fixtures use 64 retained participant facts
 * and a 32 KiB skills prompt; setup and warmup are excluded from measurement.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "./src/shared/immutable-data.ts" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "5000" },
  },
});
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(["timing", "allocation"].includes(values.mode));
const { freezeTrustedJsonSnapshot: freeze } = await import(
  pathToFileURL(path.resolve(values.owner))
);
const row = (index) => ({
  id: `synthetic-${index}`,
  kind: "agent",
  metadata: { name: `participant-${index}`, roles: ["member"] },
});
const retained = freeze(Array.from({ length: 64 }, (_, index) => row(index)));
const prompt = "Synthetic skill instructions. ".repeat(1200).slice(0, 32768);
const fresh = () => ({
  sessionId: "synthetic-session",
  skillsSnapshot: {
    prompt,
    skills: Array.from({ length: 40 }, (_, index) => ({
      name: `skill-${index}`,
      location: `/synthetic/${index}`,
    })),
  },
  participants: Array.from({ length: 64 }, (_, index) => row(index)),
});
const workloads = {
  tail: () => freeze([...retained, row(64)]),
  fresh: () => freeze(fresh()),
  retained: () => freeze(retained),
};
const proof = workloads.tail();
assert.equal(proof[0], retained[0]);
assert(Object.isFrozen(proof[64].metadata.roles));
assert.equal(Reflect.set(proof[64].metadata, "name", "changed"), false);
for (const [workload, run] of Object.entries(workloads)) {
  for (let index = 0; index < 500; index++) {
    run();
  }
  global.gc?.();
  await setImmediate();
  const profiler = values.mode === "allocation" ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const pauses = [];
  const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const hostLoadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const begin = performance.now();
  for (let index = 0; index < operations; index++) {
    run();
  }
  const elapsedMs = performance.now() - begin;
  const used = process.threadCpuUsage(cpu);
  await setImmediate();
  pauses.push(...observer.takeRecords());
  observer.disconnect();
  let sampledBytes;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    profiler.disconnect();
  }
  console.log(
    JSON.stringify({
      owner: values.owner,
      mode: values.mode,
      workload,
      operations,
      cpuMs: values.mode === "timing" ? (used.user + used.system) / 1000 : undefined,
      elapsedMs: values.mode === "timing" ? elapsedMs : undefined,
      sampledBytes,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, event) => sum + event.duration, 0),
        maxMs: Math.max(0, ...pauses.map((event) => event.duration)),
      },
      memory: process.memoryUsage(),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
}
