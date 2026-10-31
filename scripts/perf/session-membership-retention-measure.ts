/**
 * Membership read + worker-wire clone against a stopped synthetic Team-shape fixture.
 * Never use a live or production state directory. Run alternating baseline/candidate processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-membership-retention-measure.ts
 *   --fixture <synthetic-state> --output <new-dir> --iterations 2000 --page-size 128 --mode timing
 * Repeat with --mode allocation; sampled timings are diagnostic. --baseline-dir selects a sparse
 * source overlay containing src/config/sessions/session-membership-facts.ts. Each result records
 * its owner hash, value digest, CPU, allocation, GC, wire size and full-cohort retained heap.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics, serialize } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    "page-size": { type: "string", default: "128" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values.fixture && values.output, "--fixture and --output are required");
assert(typeof globalThis.gc === "function", "Run with --expose-gc");
const iterations = Number(values.iterations);
const pageSize = Number(values["page-size"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pageSize) && pageSize > 0);
assert(values.mode === "timing" || values.mode === "allocation");
const fixture = path.resolve(values.fixture);
const output = path.resolve(values.output);
const relativeOwner = "src/config/sessions/session-membership-facts.ts";
const ownerSource = values["baseline-dir"]
  ? path.resolve(values["baseline-dir"], relativeOwner)
  : fileURLToPath(new URL(`../../${relativeOwner}`, import.meta.url));
const ownerSha256 = createHash("sha256").update(readFileSync(ownerSource)).digest("hex");
mkdirSync(output);
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(output, directory));
}
const config = path.join(output, "openclaw.json");
writeFileSync(config, JSON.stringify({ plugins: { enabled: false } }));
process.env = {
  ...createGatewayBenchEnv(path.join(output, "home"), config, { startupTrace: false }),
  OPENCLAW_STATE_DIR: fixture,
  TMPDIR: path.join(output, "tmp"),
};
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const owner = await import("../../src/state/openclaw-agent-db.js");
const { readSessionMembershipFactsInDatabase } =
  await import("../../src/config/sessions/session-membership-facts.ts");
try {
  const database = owner.openOpenClawAgentDatabase({ agentId: "main", env: process.env });
  const read = (keys?: readonly string[]) =>
    structuredClone(readSessionMembershipFactsInDatabase(database, keys));
  const keys = read().facts.map((fact) => fact[0]);
  assert(keys.length >= 10_000, "Expected a Team-shaped synthetic fixture");
  const pages = Array.from({ length: Math.ceil(keys.length / pageSize) }, (_, index) =>
    keys.slice(index * pageSize, (index + 1) * pageSize),
  );
  for (const page of pages) {
    read(page);
  }
  globalThis.gc();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const gc = new GCProfiler();
  gc.start();
  const hostLoad = { before: loadavg(), after: [] as number[] };
  const cpu = process.threadCpuUsage();
  const allocatedBefore = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const started = performance.now();
  let rows = 0;
  for (let index = 0; index < iterations; index++) {
    rows += read(pages[index % pages.length]).facts.length;
  }
  const elapsedMs = performance.now() - started;
  const cpuUsage = process.threadCpuUsage(cpu);
  const allocatedAfter = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  const gcProfile = gc.stop();
  hostLoad.after = loadavg();
  let sampledAllocatedBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    const sum = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledAllocatedBytes = sum(profile.head);
  }
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const retained = read();
  globalThis.gc();
  const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
  const result = {
    node: process.version,
    mode: values.mode,
    ownerSha256,
    iterations,
    pageSize,
    rows,
    elapsedMs,
    cpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
    sampledAllocatedBytes,
    totalAllocatedBytes:
      typeof allocatedBefore === "number" && typeof allocatedAfter === "number"
        ? allocatedAfter - allocatedBefore
        : undefined,
    hostLoad,
    gcProfile,
    retainedHeapBytes,
    retainedRows: retained.facts.length,
    retainedParticipantProjections: new Set(retained.facts.map((fact) => fact[3])).size,
    serializedBytes: serialize(retained).byteLength,
    valueDigest: createHash("sha256").update(JSON.stringify(retained)).digest("hex"),
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const { gcProfile: _gcProfile, ...summary } = result;
  console.log(JSON.stringify(summary));
} finally {
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
  const lifecycle = await import("../../src/shared/global-singleton.js");
  await lifecycle.drainGlobalSingletonLifecycleState();
}
