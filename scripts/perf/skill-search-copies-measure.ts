/**
 * Compare fresh-run skill searches over 64 bundled skill bodies, 2,000 operations.
 * Save the baseline catalog beside its original so relative imports stay intact:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-search-copies-measure.ts
 *   --catalog-owner src/agents/installed-skill-catalog.baseline.ts
 * Run five paired repetitions, swapping placement/order. Repeat with --allocations
 * separately: untraced runs own CPU, GC and latency. --iterations changes work count.
 * Acceptance: identical result digest, reduced allocated bytes or CPU, no material
 * adverse CPU/GC change. Report host load and absolute deltas; control adverse GC
 * with matched A/A runs. This is owner proof, not a whole-Gateway measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { InstalledSkill } from "../../src/agents/installed-skill-catalog.js";

const { values } = parseArgs({
  options: {
    "catalog-owner": { type: "string", default: "src/agents/installed-skill-catalog.ts" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isInteger(iterations) && iterations > 0);
const { searchInstalledSkills } = (await import(
  pathToFileURL(path.resolve(values["catalog-owner"])).href
)) as typeof import("../../src/agents/installed-skill-catalog.js");
const bodies = readdirSync("skills", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join("skills", entry.name, "SKILL.md"))
  .toSorted()
  .flatMap((file) => {
    try {
      return [readFileSync(file, "utf8")];
    } catch {
      return [];
    }
  });
assert(bodies.length > 0);
const templates: InstalledSkill[] = Array.from({ length: 64 }, (_, index) => ({
  name: `guide-${index}`,
  description: `Synthetic guide ${index} for file search, messages and scheduled tasks`,
  location: `/synthetic/skills/${index}/SKILL.md`,
  source: {
    filePath: `/synthetic/skills/${index}/SKILL.md`,
    readContent: bodies[index % bodies.length]!,
  },
}));
const queries = ["file search", "scheduled tasks", "message", "guide-3", "no_such_capability"];
async function operation(iteration: number) {
  // Readers and result mappings remain run-owned; only text postings can be shared.
  const catalog = templates.map((skill) => ({ ...skill, source: { ...skill.source } }));
  return searchInstalledSkills(
    catalog,
    queries[iteration % queries.length]!,
    5,
    undefined,
    () => true,
  );
}
for (let index = 0; index < 20; index++) {
  await operation(index);
}
global.gc();
await yieldTurn();
const profiler = values.allocations ? new inspector.Session() : undefined;
profiler?.connect();
if (profiler) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({
      kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
      duration: entry.duration,
    });
  }
});
observer.observe({ entryTypes: ["gc"] });
const before = process.memoryUsage();
const hostLoadStart = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
const timings: number[] = [];
const digest = createHash("sha256");
for (let index = 0; index < iterations; index++) {
  const at = performance.now();
  const result = await operation(index);
  timings.push(performance.now() - at);
  digest.update(JSON.stringify(result));
  if (index % 20 === 0) {
    await yieldTurn();
  }
}
const cpu = process.threadCpuUsage(cpuStart);
const elapsedMs = performance.now() - start;
await yieldTurn();
observer.disconnect();
const after = process.memoryUsage();
let allocatedBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  profiler.disconnect();
}
global.gc();
const retained = process.memoryUsage();
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    catalogOwner: values["catalog-owner"],
    sampled: values.allocations,
    iterations,
    digest: digest.digest("hex"),
    skillBodies: templates.length,
    textChars: templates.reduce((total, skill) => total + skill.source.readContent!.length, 0),
    cpu,
    elapsedMs,
    allocatedBytes,
    p50Ms: timings[Math.floor(iterations * 0.5)],
    p95Ms: timings[Math.floor(iterations * 0.95)],
    p99Ms: timings[Math.floor(iterations * 0.99)],
    gc,
    before,
    after,
    retained,
    hostLoadStart,
    hostLoadEnd: loadavg(),
  }),
);
