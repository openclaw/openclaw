/**
 * Reconciliation preparation on synthetic 10k–50k-entry workspace inventories.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-manifest-comparison.ts \
 *   <owner-module.ts> [entries=10000] [iterations=50] [timing|allocation] [reconcile|overlay]
 * Use workspace-manifest-overlay.ts for the overlay workload. Each iteration
 * overlays one changed incoming file onto a prepared inventory of the same size.
 * Run baseline/candidate in alternating fresh processes, at least five pairs.
 * Timing is untraced; allocation uses 32 KiB sampling including collected objects.
 * Fixture creation, warmup and forced GC are outside the measured interval.
 * Reports process CPU (not wall latency), allocation/work, GC context and host load.
 * Endpoint memory precedes a final forced GC; retained memory follows it outside timing.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { prepareWorkspaceReconciliation } from "../../src/gateway/worker-environments/workspace-manifest-comparison.js";
import type { applyWorkspaceSourceOverlay } from "../../src/gateway/worker-environments/workspace-manifest-overlay.js";
import type { WorkerWorkspaceManifest } from "../../src/gateway/worker-environments/workspace-manifest.js";

const modulePath = path.resolve(process.argv[2]!);
const count = Number(process.argv[3] ?? 10_000);
const iterations = Number(process.argv[4] ?? 50);
const mode = process.argv[5] ?? "timing";
const workload = process.argv[6] ?? "reconcile";
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(mode === "timing" || mode === "allocation");
assert.ok(workload === "reconcile" || workload === "overlay");
assert.ok(global.gc, "requires --expose-gc");
const comparison: {
  prepareWorkspaceReconciliation: typeof prepareWorkspaceReconciliation;
  applyWorkspaceSourceOverlay: typeof applyWorkspaceSourceOverlay;
} = await import(pathToFileURL(modulePath).href);
const entries: WorkerWorkspaceManifest["entries"] = Array.from({ length: count }, (_, index) => ({
  path: `packages/package-${Math.floor(index / 100)}/src/${index % 20 === 0 ? "__pycache__" : "components"}/file-${index}.ts`,
  type: "file",
  mode: 0o644,
  size: 128,
  sha256: "a".repeat(64),
}));
const directories = new Set<string>();
for (const entry of entries) {
  for (
    let index = entry.path.indexOf("/");
    index >= 0;
    index = entry.path.indexOf("/", index + 1)
  ) {
    directories.add(entry.path.slice(0, index));
  }
}
const base: WorkerWorkspaceManifest = {
  version: 1,
  baseCommit: null,
  entries,
  directories: [...directories],
};
const current: WorkerWorkspaceManifest = {
  ...base,
  entries: entries.map((entry, index) =>
    index === 1 ? { ...entry, sha256: "b".repeat(64) } : { ...entry },
  ),
};
const run = () =>
  workload === "overlay"
    ? comparison.applyWorkspaceSourceOverlay(base, base, current)
    : comparison.prepareWorkspaceReconciliation(base, current);
for (let index = 0; index < 5; index++) {
  run();
}
global.gc();
await setImmediate();
let gcMs = 0;
let gcCount = 0;
let gcMaxMs = 0;
const gcByKind: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
    gcCount++;
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
    const kind = String((entry as PerformanceNodeEntry).detail.kind);
    const stats = (gcByKind[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    stats.count++;
    stats.totalMs += entry.duration;
    stats.maxMs = Math.max(stats.maxMs, entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = os.loadavg();
const startCpu = process.cpuUsage();
const start = performance.now();
let result;
for (let index = 0; index < iterations; index++) {
  result = run();
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(startCpu);
let allocatedBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
await setImmediate();
await setImmediate();
observer.disconnect();
const memory = process.memoryUsage();
global.gc();
const retainedMemory = process.memoryUsage();
assert.ok(result);
if ("changed" in result) {
  assert.deepEqual([...result.changed], [entries[1]!.path]);
  assert.equal(result.preflight.changedPaths.length, 1);
} else {
  assert.equal(result.entries.length, entries.filter((_, index) => index % 20 !== 0).length);
  assert.deepEqual(
    result.entries.find((entry) => entry.path === entries[1]!.path),
    current.entries[1],
  );
}
console.log(
  JSON.stringify({
    modulePath,
    count,
    iterations,
    mode,
    workload,
    node: process.version,
    hostLoad,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuMsPerReconcile: (cpu.user + cpu.system) / 1000 / iterations,
    allocatedBytes,
    allocatedBytesPerReconcile:
      allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    gcMs,
    gcCount,
    gcMaxMs,
    gcByKind,
    memory,
    retainedMemory,
  }),
);
