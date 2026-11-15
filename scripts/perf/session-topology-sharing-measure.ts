/**
 * Child-bucket ownership proof, not Gateway/transport latency.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-topology-sharing-measure.ts \
 *   --base-source <pinned-topology.ts> --mode timing [--memory absent|same|distinct]
 * Keep the pinned source beside its original so relative imports remain intact.
 * Repeat with --mode allocation; --snapshots <directory> writes synthetic heap snapshots.
 * Five AB/BA pairs build 19,500 child entries and patch 3,000 rows per arm. Imports,
 * fixtures, warmup, forced GC and heap snapshots are outside measured windows.
 * Acceptance: lower retained heap/build allocation for shared buckets, identical
 * child answers and held snapshots, with no consistent patch CPU/allocation regression.
 * Distinct live owners require their own merged array and are a neutral control.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import type { buildSubagentRunReadTopology } from "../../src/agents/subagents/registry/subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "../../src/agents/subagents/registry/subagent-registry-read.types.js";

const { values } = parseArgs({
  options: {
    "base-source": { type: "string" },
    mode: { type: "string", default: "timing" },
    memory: { type: "string", default: "absent" },
    snapshots: { type: "string" },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(values["base-source"], "Pass --base-source");
assert(values.mode === "timing" || values.mode === "allocation");
assert(["absent", "same", "distinct"].includes(values.memory));
const sourcePaths = {
  base: path.resolve(values["base-source"]),
  candidate: path.resolve("src/agents/subagents/registry/subagent-registry-read-topology.ts"),
};
const owners: Record<string, typeof buildSubagentRunReadTopology> = {};
for (const [arm, source] of Object.entries(sourcePaths)) {
  const module: typeof import("../../src/agents/subagents/registry/subagent-registry-read-topology.js") =
    await import(pathToFileURL(source).href);
  owners[arm] = module.buildSubagentRunReadTopology;
}
const rows: SubagentRunReadRecord[] = Array.from({ length: 19_500 }, (_, i) => ({
  runId: `synthetic-${i}`,
  childSessionKey: `agent:main:subagent:${i}`,
  requesterSessionKey: `agent:main:parent-${i % 1_300}`,
  createdAt: i + 1,
  generation: 1,
  execution: { status: "terminal", endedAt: i + 2 },
  delivery: { status: "not_required" },
}));
const memory =
  values.memory === "absent"
    ? []
    : values.memory === "same"
      ? rows
      : rows.map((row) => ({ ...row }));
const build = (arm: string) =>
  owners[arm]!({ runs: new Map(rows.map((row) => [row.runId, row])), inMemoryRuns: memory });
const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
const inspector = new Session();
inspector.connect();
console.log(
  JSON.stringify({
    mode: values.mode,
    memory: values.memory,
    node: process.version,
    children: rows.length,
    sources: Object.fromEntries(
      Object.entries(sourcePaths).map(([arm, source]) => [
        arm,
        {
          path: source,
          sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
        },
      ]),
    ),
  }),
);

async function retained(arm: string) {
  global.gc!();
  const before = process.memoryUsage();
  const topology = build(arm);
  await nextTurn();
  global.gc!();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ arm, retainedHeapBytes: after.heapUsed - before.heapUsed, after }));
  if (values.snapshots) {
    mkdirSync(values.snapshots, { recursive: true });
    writeHeapSnapshot(path.join(values.snapshots, `${arm}-${values.memory}.heapsnapshot`));
  }
  assert.equal(topology.runsByChildSessionKey.size, rows.length);
}
try {
  for (const arm of ["base", "candidate"]) {
    build(arm);
  }
  await nextTurn();
  for (const arm of ["base", "candidate"]) {
    await retained(arm);
    await nextTurn();
  }
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
      for (const workload of ["build", "patch"] as const) {
        const topology = build(arm);
        const empty = new Map<string, SubagentRunReadRecord>();
        const changes = new Map<string, SubagentRunReadRecord>();
        const held = topology.runsByChildSessionKey.get(rows[0]!.childSessionKey)!;
        const iterations = workload === "build" ? 5 : 3_000;
        await nextTurn();
        global.gc!();
        if (values.mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        let checksum = 0;
        for (let i = 0; i < iterations; i++) {
          if (workload === "build") {
            checksum += build(arm).runsByChildSessionKey.size;
          } else {
            const row = rows[i % rows.length]!;
            const next = { ...row, createdAt: row.createdAt + 1 };
            changes.clear();
            changes.set(row.runId, next);
            topology.patch(changes, empty);
            const published = topology.runsByChildSessionKey.get(row.childSessionKey)!;
            assert.equal(published[0], next);
            checksum += published.length;
          }
        }
        const elapsedMs = performance.now() - started;
        const used = process.threadCpuUsage(cpu);
        const allocatedBytes =
          values.mode === "allocation"
            ? bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
        assert.equal(held[0], rows[0], "patch mutated a held child snapshot");
        console.log(
          JSON.stringify({
            pair,
            arm,
            workload,
            iterations,
            checksum,
            elapsedMs,
            mainThreadCpuUsPerOperation: (used.user + used.system) / iterations,
            allocatedBytesPerOperation:
              allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
            hostLoad,
            hostLoadAfter: loadavg(),
          }),
        );
      }
    }
  }
} finally {
  inspector.disconnect();
}
