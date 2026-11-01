/**
 * Valid-config guard CPU and allocation, with a prepared synthetic snapshot (40 plugins,
 * eight agents). Only the guard's config I/O dependency is replaced; the guard is real.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/config-guard-startup-measure.ts
 *   --iterations 5000 --mode timing --output .local/config-guard-timing.json
 * Add --owner /absolute/base-config-guard.ts to run saved source in the same import graph.
 * Alternate base/candidate order; run --mode allocation separately (4 KiB sampling,
 * including collected objects). This measures warm owner work, not Gateway startup time.
 * Acceptance: identical read/publication counts and identities, lower CPU/allocation.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import {
  constants,
  PerformanceObserver,
  type PerformanceEntry,
  type PerformanceNodeEntry,
} from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "5000" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
assert(values.mode === "timing" || values.mode === "allocation", "Invalid --mode");
assert(globalThis.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 5000,
  min: 1,
  label: "iterations",
});
const ownerUrl = new URL("../../src/cli/program/config-guard.ts", import.meta.url).href;
const replacement = values.owner ? pathToFileURL(path.resolve(values.owner)).href : undefined;
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
  const config = {
    gateway: { mode: "local" },
    agents: { list: Array.from({ length: 8 }, (_, i) => ({ id: "agent-" + i })) },
    plugins: { entries: Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      ["synthetic-plugin-" + i, { enabled: true, config: { label: "plugin-" + i } }])) },
  };
  const sourceConfig = structuredClone(config);
  const snapshot = { exists: true, valid: true, config, runtimeConfig: config,
    sourceConfig, issues: [], legacyIssues: [], warnings: [] };
  export let reads = 0;
  export let publications = 0;
  export function reset() { reads = 0; publications = 0; }
  export async function readConfigFileSnapshot() { reads++; return snapshot; }
  export function setRuntimeConfigSnapshot(runtime, source) {
    if (runtime !== config || source !== sourceConfig) throw new Error("Publication identity changed");
    publications++;
  }
`)}`;
let replaced = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ownerUrl && specifier === "../../config/config.js") {
      return { url: fixtureUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== ownerUrl || !replacement) {
      return nextLoad(url, context);
    }
    replaced = true;
    const result = nextLoad(replacement, context);
    return { format: result.format, source: result.source, shortCircuit: true };
  },
});
const { ensureConfigReady } = await import("../../src/cli/program/config-guard.js");
const fixture: { reads: number; publications: number; reset: () => void } = await import(
  fixtureUrl
);
assert(!replacement || replaced, "Requested baseline source was not loaded");
const unexpected = (...args: unknown[]) => {
  throw new Error(`Unexpected guard diagnostic/exit: ${args.join(" ")}`);
};
const params = {
  commandPath: ["gateway", "run"],
  validateConfigOnly: true,
  runtime: { log: unexpected, error: unexpected, exit: unexpected },
};
async function run(count: number) {
  fixture.reset();
  for (let index = 0; index < count; index++) {
    await ensureConfigReady(params);
  }
  assert.equal(fixture.reads, count);
  assert.equal(fixture.publications, count);
  return `${fixture.reads}:${fixture.publications}:same-runtime-and-source`;
}
await run(1000);
globalThis.gc();
await setImmediate();
const collections: PerformanceEntry[] = [];
const observer = new PerformanceObserver((batch) => collections.push(...batch.getEntries()));
const inspector = new Session();
try {
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = await run(iterations);
  const ended = performance.now();
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes =
    values.mode === "allocation"
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  await setImmediate();
  collections.push(...observer.takeRecords());
  const gc = collections.filter((entry) => entry.startTime >= started && entry.startTime < ended);
  const gcByKind = Object.fromEntries(
    [
      ["minor", constants.NODE_PERFORMANCE_GC_MINOR],
      ["major", constants.NODE_PERFORMANCE_GC_MAJOR],
      ["incremental", constants.NODE_PERFORMANCE_GC_INCREMENTAL],
      ["weakCallbacks", constants.NODE_PERFORMANCE_GC_WEAKCB],
    ].map(([name, kind]) => {
      // The observer only subscribes to Node's GC entries, whose detail contains kind.
      const events = gc.filter((entry) => (entry as PerformanceNodeEntry).detail.kind === kind);
      return [
        name,
        { count: events.length, totalMs: events.reduce((sum, e) => sum + e.duration, 0) },
      ];
    }),
  );
  const result = {
    mode: values.mode,
    owner: values.owner ?? ownerUrl,
    node: process.version,
    iterations,
    warmup: 1000,
    plugins: 40,
    agents: 8,
    checksum,
    cpuMs: values.mode === "timing" ? (used.user + used.system) / 1000 : undefined,
    wallMs: values.mode === "timing" ? ended - started : undefined,
    allocatedBytes,
    gc:
      values.mode === "timing"
        ? {
            count: gc.length,
            totalMs: gc.reduce((sum, entry) => sum + entry.duration, 0),
            maxMs: gc.reduce((max, entry) => Math.max(max, entry.duration), 0),
            byKind: gcByKind,
          }
        : undefined,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
  };
  const json = JSON.stringify(result, null, 2);
  if (values.output) {
    writeFileSync(values.output, `${json}\n`);
  }
  console.log(json);
} finally {
  observer.disconnect();
  inspector.disconnect();
}
