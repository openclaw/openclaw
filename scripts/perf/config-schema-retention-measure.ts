/**
 * Retained config schemas across 40-plugin metadata generations, keeping only the
 * current response. Run each arm in a fresh process, reversing launch order:
 * node --import ./scripts/tsx.mjs scripts/perf/config-schema-retention-measure.ts
 *   --iterations 1000 [--owner-file /absolute/baseline-schema.ts] [--allocations]
 *   [--snapshot /absolute/endpoint.heapsnapshot] [--assert-released]
 * Each generation yields so WeakRefs do not pin obsolete responses for the job.
 * Timing and allocation passes are separate. Endpoint GC is outside the measured
 * window. This is schema generation churn, not warm Gateway schema reads: those
 * are cached by config/plugin generation at the runtime owner.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "80" },
    "owner-file": { type: "string" },
    allocations: { type: "boolean", default: false },
    snapshot: { type: "string" },
    "assert-released": { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 2);
const ownerUrl = new URL("../../src/config/schema.ts", import.meta.url);
let ownerLoaded = false;
if (values["owner-file"]) {
  const replacement = pathToFileURL(path.resolve(values["owner-file"]));
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl.href) {
        return nextLoad(url, context);
      }
      ownerLoaded = true;
      const loaded = nextLoad(replacement.href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const { buildConfigSchemaCore } = await import("../../src/config/schema.ts");
assert(!values["owner-file"] || ownerLoaded, "Requested schema owner was not loaded");
const plugins = Array.from({ length: 40 }, (_plugin, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic ${index}`,
  configSchema: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 20 }, (_field, field) => [
        `setting${field}`,
        { type: "string", description: `Setting ${field} for synthetic plugin ${index}` },
      ]),
    ),
  },
}));
buildConfigSchemaCore();
const inspector = new Session();
inspector.connect();
try {
  await inspector.post("HeapProfiler.collectGarbage");
  const heapBefore = process.memoryUsage().heapUsed;
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
  }
  const references: WeakRef<object>[] = [];
  let current;
  const hostLoadBefore = loadavg();
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  for (let revision = 0; revision < iterations; revision++) {
    current = buildConfigSchemaCore({
      plugins: plugins.map((plugin) => ({ ...plugin, description: `revision ${revision}` })),
    });
    references.push(new WeakRef(current));
    await nextTurn();
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const control = new WeakRef({});
  await nextTurn();
  await inspector.post("HeapProfiler.collectGarbage");
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  const liveSchemas = references.filter((reference) => reference.deref() !== undefined).length;
  assert(current);
  const result = {
    mode: values.allocations ? "allocation" : "timing",
    iterations,
    plugins: plugins.length,
    propertiesPerPlugin: 20,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledAllocatedBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
    allocationSamples: profile?.samples.length,
    heapBefore,
    heapAfter,
    retainedDeltaBytes: heapAfter - heapBefore,
    liveSchemas,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    schemaDigest: createHash("sha256")
      .update(JSON.stringify({ schema: current.schema, uiHints: current.uiHints }))
      .digest("hex"),
  };
  console.log(JSON.stringify(result));
  if (values.snapshot) {
    // deref() keeps targets alive for this job; snapshot the actual owners next.
    await nextTurn();
    await inspector.post("HeapProfiler.collectGarbage");
    writeHeapSnapshot(path.resolve(values.snapshot));
    assert(current.schema);
  }
  if (values["assert-released"]) {
    assert.equal(liveSchemas, 1, "Only the caller-owned current schema may remain live");
  }
} finally {
  inspector.disconnect();
}
