/**
 * Measure schema-owner evaluation with warm dependencies and fresh module instances.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-engine-schema-bench.ts
 * Add --owner-source <saved-state-db-engine.ts> for a baseline; alternate launch order.
 * Run --allocation separately for sampled allocation; --iterations defaults to 100.
 * --expected-schema-sha256 pins the fully materialized schema contract before capture.
 * This reads static schema definitions only, never opens a database, and does not
 * measure cold dependency loading or whole-Gateway startup. ESM retains each instance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-source": { type: "string" },
    iterations: { type: "string", default: "100" },
    allocation: { type: "boolean", default: false },
    "expected-schema-sha256": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
const unusedStateDir = path.resolve(`.local/state-engine-schema-bench-${process.pid}`);
process.env.OPENCLAW_STATE_DIR = unusedStateDir;
process.env.OPENCLAW_HOME = unusedStateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(unusedStateDir, "openclaw.json");
const ownerUrl = new URL("../../src/state/openclaw-state-db-engine.ts", import.meta.url);
const source = readFileSync(values["owner-source"] ?? ownerUrl, "utf8");
const compiled = stripTypeScriptTypes(source);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let loaded = 0;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href && !url.startsWith(`${ownerUrl.href}?`)) {
      return nextLoad(url, context);
    }
    loaded++;
    return { format: "module", source: compiled, shortCircuit: true };
  },
});
const inspector = new Session();
try {
  // Materialize once outside capture; this also warms the exact dependency graph.
  const warm = await import(`${ownerUrl.href}?schema-bench=warm`);
  const serialized = JSON.stringify(warm.stateEngineSchema);
  const schemaSha256 = hash(serialized);
  if (values["expected-schema-sha256"]) {
    assert.equal(schemaSha256, values["expected-schema-sha256"]);
  }
  const schemaBytes = Buffer.byteLength(serialized);
  const loadedBefore = loaded;
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const hostLoadBefore = loadavg();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let gcMs = 0;
  let gcCount = 0;
  const gc = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });
  await nextTurn();
  gc.observe({ entryTypes: ["gc"] });
  const cpuBefore = process.threadCpuUsage();
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index++) {
    await import(`${ownerUrl.href}?schema-bench=${index}`);
  }
  const wallMs = performance.now() - startedAt;
  const cpu = process.threadCpuUsage(cpuBefore);
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  let sampledAllocationBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledAllocationBytes = sum(profile.head);
  }
  await nextTurn();
  for (const entry of gc.takeRecords()) {
    gcMs += entry.duration;
    gcCount++;
  }
  gc.disconnect();
  globalThis.gc();
  const retainedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(loaded - loadedBefore, iterations, "Every iteration must evaluate a fresh owner");
  console.log(
    JSON.stringify({
      ownerSha256: hash(source),
      schemaSha256,
      schemaBytes,
      iterations,
      mode: values.allocation ? "allocation" : "timing",
      wallMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      gcMs: values.allocation ? undefined : gcMs,
      gcCount: values.allocation ? undefined : gcCount,
      heapDeltaBytes: values.allocation ? undefined : heapDeltaBytes,
      retainedHeapDeltaBytes: values.allocation ? undefined : retainedHeapDeltaBytes,
      sampledAllocationBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
  hooks.deregister();
}
