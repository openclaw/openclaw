// Run: node --expose-gc scripts/perf/worktree-preparation-index-measure.ts
// --owner <gc-dependencies.ts> --mode base|candidate [--allocation] [--churn]
// Compare pinned base/candidate owner files in alternating, separate processes.
// 3,000 managed worktrees, four owned paths each, 2,000 preparations after 20 warmups.
// Structured-cloned inventories model fresh worker reply objects and strings; worker I/O,
// transfer, Git census and source leases are excluded from this owner measurement.
// --churn alternates allocation/release of one worktree on every preparation.
// Timing/CPU runs are untraced; sampled allocation uses its own pass. Acceptance:
// identical ancestry answers, lower CPU/allocation, no material wall regression.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as PathIndex from "../../src/agents/worktrees/gc-dependencies.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string" },
    allocation: { type: "boolean" },
    churn: { type: "boolean" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.owner && (values.mode === "base" || values.mode === "candidate"));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner: typeof PathIndex = await import(pathToFileURL(path.resolve(values.owner)).href);
const prepare =
  values.mode === "base" ? owner.indexWorktreePaths : owner.createPreparedWorktreePathIndex();
const paths = (id: number) => [
  { id: `tree-${id}`, path: `/fixture/worktrees/tree-${id}` },
  { id: `tree-${id}`, path: `/fixture/worktrees/tree-${id}` },
  { id: `tree-${id}`, path: `/fixture/repo/.git/worktrees/tree-${id}` },
  { id: `tree-${id}`, path: `/fixture/repo/.git/worktrees/tree-${id}` },
];
const first = Array.from({ length: 3000 }, (_, id) => paths(id)).flat();
const second = [...(values.churn ? paths(3000) : []), ...structuredClone(first)];
const inventories = [first, second];
// Keep the unchanged snapshot distinct from both measured replies, as across a worker boundary.
prepare(structuredClone(first));
function operation(index: number) {
  const ancestors = prepare(inventories[index % 2]!);
  assert.deepEqual(
    [...ancestors("/fixture/worktrees/tree-42/nested/file")],
    ["tree-42", "tree-42"],
  );
  assert.deepEqual([...ancestors("/fixture/worktrees/tree-4200/file")], []);
  assert.deepEqual(
    [...ancestors("/fixture/worktrees/tree-3000/file")],
    values.churn && index % 2 ? ["tree-3000", "tree-3000"] : [],
  );
}
for (let index = 0; index < 20; index++) {
  operation(index);
}
globalThis.gc?.();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const loadBefore = loadavg();
const cpu = process.cpuUsage();
const started = performance.now();
const timings: number[] = [];
for (let index = 0; index < iterations; index++) {
  const before = performance.now();
  operation(index);
  timings.push(performance.now() - before);
}
const elapsedMs = performance.now() - started;
const used = process.cpuUsage(cpu);
let bytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  bytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  inspector.disconnect();
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    mode: values.mode,
    churn: Boolean(values.churn),
    allocation: Boolean(values.allocation),
    iterations,
    worktrees: 3000,
    elapsedMs,
    wallMsPerPreparation: elapsedMs / iterations,
    cpuMsPerPreparation: (used.user + used.system) / 1000 / iterations,
    p50Ms: timings[Math.floor(iterations * 0.5)],
    p95Ms: timings[Math.floor(iterations * 0.95)],
    allocationBytesPerPreparation: bytes === undefined ? undefined : bytes / iterations,
    loadBefore,
    loadAfter: loadavg(),
    memory: process.memoryUsage(),
  }),
);
