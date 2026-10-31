/**
 * Synthetic discovery precedence cost, with 40 roots repeating 32 skill names.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-collision-diagnostics-measure.ts
 *   --owner src/skills/loading/skill-precedence.baseline.ts --diagnostics --iterations 2000
 * Save the base owner beside its source before editing, then omit --owner and
 * --diagnostics for the candidate. Run five AB/BA pairs; --allocations is a
 * separate sampled pass (includes minor/major-collected objects). --prepare
 * creates the isolated fixture once; --fixture selects its absolute directory.
 * Acceptance: identical selection digest, fewer path resolutions, reduced CPU
 * or allocation, no material adverse GC. Report absolute deltas and host load.
 * This measures the merger, not whole-Gateway latency or total discovery cost.
 * --worker src/skills/runtime/discovery.worker.ts --iterations 10 measures full
 * scans through the worker transport after three warmup scans. For the base,
 * save discovery.baseline.worker.ts beside the worker and point its precedence
 * import at skill-precedence.baseline.js. Worker garbage is native GC reclaimed
 * bytes, not sampled allocation; heap high-water is sampled before collections.
 * Use the same fixture directory for both sides; output digests must match.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSyntheticSourceInfo, type Skill } from "../../src/skills/loading/skill-contract.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/skills/loading/skill-precedence.ts" },
    fixture: { type: "string", default: ".local/skill-collision-fixture" },
    iterations: { type: "string", default: "2000" },
    diagnostics: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    prepare: { type: "boolean", default: false },
    worker: { type: "string" },
  },
});
assert(global.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const fixture = path.resolve(values.fixture);
const records: { skill: Skill }[] = [];
for (let root = 0; root < 40; root++) {
  for (let name = 0; name < 32; name++) {
    const baseDir = path.join(fixture, String(root), `guide-${name}`);
    const filePath = path.join(baseDir, "SKILL.md");
    if (values.prepare) {
      mkdirSync(baseDir, { recursive: true });
      writeFileSync(
        filePath,
        `---\nname: guide-${name}\ndescription: Synthetic ${root}\n---\nInstructions\n`,
      );
    }
    records.push({
      skill: {
        name: `guide-${name}`,
        description: `Synthetic ${root}`,
        baseDir,
        filePath,
        source: "openclaw-managed",
        sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-managed" }),
        disableModelInvocation: false,
      },
    });
  }
}
if (values.prepare) {
  process.exit(0);
}
if (values.worker) {
  const { WorkerTaskPool } = await import("../../src/infra/worker-task-pool.js");
  const { sampleTrackedWorkerMemory, setTrackedWorkerGcObserver } =
    await import("../../src/infra/worker-cpu.js");
  const { captureSkillsDiscoveryEnvironment } =
    await import("../../src/skills/runtime/discovery-worker-contract.js");
  const pool = new WorkerTaskPool<
    import("../../src/skills/runtime/discovery-worker-contract.js").SkillsDiscoveryInput,
    import("../../src/skills/runtime/discovery-worker-contract.js").SkillsDiscoveryOutput
  >({
    workerUrl: pathToFileURL(path.resolve(values.worker)),
    maxWorkers: 1,
  });
  const environment = {
    ...captureSkillsDiscoveryEnvironment(),
    OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  };
  const input = {
    kind: "scan" as const,
    path: "",
    requests: [
      {
        key: "synthetic",
        environment,
        selection: {
          kind: "selected" as const,
          request: {
            sourcePlan: {
              workspaceDir: fixture,
              managedSkillsDir: fixture,
              pluginSkillRoots: [],
              roots: Array.from({ length: 40 }, (_, index) => ({
                dir: path.join(fixture, String(index)),
                source: "openclaw-managed",
                tier: "managed" as const,
              })),
            },
            limits: {
              maxCandidatesPerRoot: 100,
              maxSkillsLoadedPerSource: 100,
              maxSkillFileBytes: 1024,
            },
            additionalBins: [],
          },
        },
      },
    ],
  };
  let reclaimedBytes = 0;
  let gcMs = 0;
  let gcCount = 0;
  let maxPauseMs = 0;
  let heapHighWaterBytes = 0;
  setTrackedWorkerGcObserver((samples) => {
    for (const sample of samples) {
      reclaimedBytes += sample.reclaimedBytes ?? 0;
      gcMs += sample.durationMs;
      gcCount++;
      maxPauseMs = Math.max(maxPauseMs, sample.durationMs);
      heapHighWaterBytes = Math.max(heapHighWaterBytes, sample.heapUsedBeforeBytes ?? 0);
    }
  });
  for (let i = 0; i < 3; i++) {
    await pool.run(input, { inputBytes: JSON.stringify(input).length });
  }
  // Drain the native sampler's one-second cadence before excluding warmup.
  await delay(1100);
  reclaimedBytes = gcMs = gcCount = maxPauseMs = heapHighWaterBytes = 0;
  const digest = createHash("sha256");
  const hostLoadStart = loadavg();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    for (let i = 0; i < iterations; i++) {
      const result = await pool.run(input, { inputBytes: JSON.stringify(input).length });
      assert.equal(result.kind, "scan");
      if (result.kind === "scan") {
        assert.equal(result.results[0]!.sources.entries.length, 1280);
      }
      digest.update(JSON.stringify(result));
    }
  } finally {
    await pool.close();
  }
  const cpu = process.cpuUsage(cpuStart);
  const metrics = sampleTrackedWorkerMemory().workerTaskMetrics;
  console.log(
    JSON.stringify({
      worker: values.worker,
      iterations,
      digest: digest.digest("hex"),
      cpuMs: (cpu.user + cpu.system) / 1000,
      elapsedMs: performance.now() - start,
      reclaimedBytes,
      gcMs,
      gcCount,
      maxPauseMs,
      heapHighWaterBytes,
      metrics,
      hostLoadStart,
      hostLoadEnd: loadavg(),
    }),
  );
  setTrackedWorkerGcObserver(undefined);
  process.exit(0);
}
const { mergeSkillRecords } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/skills/loading/skill-precedence.js");
const run = () => mergeSkillRecords(records, fixture, values.diagnostics ? [] : false);
for (let i = 0; i < 10; i++) {
  run();
}
global.gc();
await yieldTurn();
const profiler = values.allocations ? new inspector.Session() : undefined;
profiler?.connect();
if (profiler) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc: { kind: number; duration: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({
      kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
      duration: entry.duration,
    });
  }
});
observer.observe({ entryTypes: ["gc"] });
const hostLoadStart = loadavg();
const before = process.memoryUsage();
let heapHighWaterBytes = before.heapUsed;
const cpuStart = process.cpuUsage();
const start = performance.now();
let result: { skill: Skill }[] = [];
for (let i = 0; i < iterations; i++) {
  result = run();
  if (i % 20 === 0) {
    heapHighWaterBytes = Math.max(heapHighWaterBytes, process.memoryUsage().heapUsed);
    await yieldTurn();
  }
}
const cpu = process.cpuUsage(cpuStart);
const elapsedMs = performance.now() - start;
await yieldTurn();
observer.disconnect();
let allocatedBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  profiler.disconnect();
}
assert.equal(result.length, 32);
assert(result.every(({ skill }) => skill.description === "Synthetic 39"));
console.log(
  JSON.stringify({
    owner: values.owner,
    iterations,
    records: records.length,
    sampled: values.allocations,
    digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    cpuMs: (cpu.user + cpu.system) / 1000,
    elapsedMs,
    allocatedBytes,
    heapHighWaterBytes,
    before,
    after: process.memoryUsage(),
    gc,
    hostLoadStart,
    hostLoadEnd: loadavg(),
  }),
);
