// Run on the benchmark host: node --expose-gc scripts/perf/heap-headroom.ts
//   --source-root <checkout-or-narrow-capsule> --revision <ref> --output <file>
// Pair identical invocations with --start-at, swap CPU halves, and compare paired deltas.
// This measures the real exporter/store and GC-profile drain, not Gateway throughput.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker, type MessagePort } from "node:worker_threads";
import type { DiagnosticMemoryUsage } from "../../src/infra/diagnostic-process-types.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    revision: { type: "string" },
    output: { type: "string" },
    "start-at": { type: "string" },
    rounds: { type: "string", default: "25" },
    iterations: { type: "string", default: "1000" },
    workers: { type: "string", default: "32" },
  },
});
assert(values.output && values.revision, "--output and --revision are required");
assert(globalThis.gc, "Run with --expose-gc");
const integer = (raw: string | undefined, label: string, fallback: number) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback });
const rounds = integer(values.rounds, "--rounds", 25);
const iterations = integer(values.iterations, "--iterations", 1000);
const workerCount = integer(values.workers, "--workers", 32);
const root = resolve(values["source-root"]);
const files = [
  "src/infra/gc-observer.ts",
  "extensions/diagnostics-prometheus/src/service-memory.ts",
  "extensions/diagnostics-prometheus/src/prometheus-metric-store.ts",
  "extensions/diagnostics-prometheus/src/prometheus-format.ts",
  "packages/normalization-core/src/number-coercion.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "src/infra/worker-memory.ts",
] as const;
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(resolve(root, file)))
        .digest("hex"),
    ]),
  ),
);

// Native TypeScript loading needs only import resolution, leaving measured source unchanged.
// Map the SDK numeric barrel to its canonical owner to avoid unrelated runtime startup.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openclaw/plugin-sdk/number-runtime") {
      return { url: pathToFileURL(resolve(root, files[4])).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const candidate = new URL(specifier.replace(/\.js$/u, ".ts"), context.parentURL);
      if (candidate.protocol === "file:" && existsSync(candidate)) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
const { recordMemorySample } = await import(pathToFileURL(resolve(root, files[1])).href);
const { createPrometheusMetricStore } = await import(pathToFileURL(resolve(root, files[2])).href);
const observer = await import(pathToFileURL(resolve(root, files[0])).href);
hooks.deregister();

const mib = 1024 ** 2;
const scripts = [
  "code-mode-node.worker.js",
  "sqlite-store.worker.js",
  "prepared-model-catalog.worker.js",
  "other",
];
const workerHeaps = Array.from({ length: workerCount }, (_, index) => ({
  script: scripts[index % scripts.length]!,
  threadId: index + 1,
  heapUsed: (80 + index) * mib,
  heapTotal: 160 * mib,
  heapSizeLimitBytes: 512 * mib,
  oldGenerationAfterGcBytes: (60 + index) * mib,
  external: 8 * mib,
  arrayBuffers: 4 * mib,
  heapSpaces: [
    { space_name: "old_space", space_used_size: (50 + index) * mib },
    { space_name: "large_object_space", space_used_size: 10 * mib },
  ],
}));
const memory: DiagnosticMemoryUsage = {
  rssBytes: 4_000 * mib,
  heapTotalBytes: 1_500 * mib,
  heapUsedBytes: 1_000 * mib,
  heapSizeLimitBytes: 4_096 * mib,
  oldGenerationAfterGcBytes: 800 * mib,
  externalBytes: 128 * mib,
  arrayBuffersBytes: 64 * mib,
  workerCount,
  workerHeapSampledCount: workerCount,
  workerHeaps,
};
const store = createPrometheusMetricStore();
const byteBuckets = [256 * mib, 1_024 * mib, 4_096 * mib, 16_384 * mib];
const sample = () => recordMemorySample(store, memory, byteBuckets);
for (let index = 0; index < iterations; index++) {
  sample();
}
globalThis.gc();
if (values["start-at"]) {
  const startAt = integer(values["start-at"], "--start-at", 1);
  assert(startAt > Date.now(), "Missed synchronized start");
  await delay(startAt - Date.now());
}
const startedAt = Date.now();
const summarize = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    samples,
  };
};
const exportMs: number[] = [];
const exportCpu = process.cpuUsage();
for (let round = 0; round < rounds; round++) {
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    sample();
  }
  exportMs.push((performance.now() - start) / iterations);
}
const exportCpuUsage = process.cpuUsage(exportCpu);
const rendered = store.render();
assert(!rendered.includes("openclaw_prometheus_series_dropped_total"), "Series overflow");
const series = rendered.split("\n").filter((line: string) => line && !line.startsWith("#"));
assert(series.some((line: string) => line.startsWith("openclaw_worker_heap_used_bytes")));

let majorCollections = 0;
const stop = observer.observeGcSamples((samples: Array<{ kind: string }>) => {
  majorCollections += samples.filter((entry) => entry.kind === "mark_sweep_compact").length;
});
const drainMs: number[] = [];
for (let index = 0; index < 100; index++) {
  globalThis.gc();
  // Joining a subscriber drains the actual native profile synchronously; GC is outside timing.
  const start = performance.now();
  const unsubscribe = observer.observeGcSamples(() => {});
  drainMs.push(performance.now() - start);
  unsubscribe();
}
const oldGenerationAfterGcBytes = observer.getOldGenerationAfterGcBytes?.();
stop();
assert(majorCollections >= drainMs.length, "Major collections were not observed");
if (observer.getOldGenerationAfterGcBytes) {
  assert(oldGenerationAfterGcBytes > 0, "Missing native post-major-GC baseline");
}
// Real isolate and private MessagePort proof is outside both timing windows.
const worker = new Worker(
  `
  const { parentPort, workerData } = require('node:worker_threads');
  parentPort.on('message', () => {});
  require('node:module').registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return { url: new URL(specifier.replace(/\\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  }});
  (async () => {
    const gc = await import(workerData.gc);
    const memory = await import(workerData.memory);
    gc.observeGcSamples(() => {});
    memory.serveWorkerMemorySamples(parentPort);
    global.gc();
    gc.observeGcSamples(() => {})();
    parentPort.postMessage({ ready: true });
  })().catch(error => { throw error; });
`,
  {
    eval: true,
    workerData: {
      gc: pathToFileURL(resolve(root, files[0])).href,
      memory: pathToFileURL(resolve(root, files[6])).href,
    },
  },
);
type WorkerMemoryProof = {
  heapSizeLimitBytes?: number;
  heapUsed: number;
  oldGenerationAfterGcBytes?: number;
};
let workerMemory: WorkerMemoryProof;
try {
  workerMemory = await new Promise<WorkerMemoryProof>((resolveSample, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker memory proof timed out")), 10_000);
    let port: MessagePort;
    let received = 0;
    worker.once("error", reject);
    worker.on("message", (message) => {
      if (message.port) {
        port = message.port;
        port.on("message", (workerSample) => {
          if (++received === 2) {
            clearTimeout(timeout);
            port.close();
            resolveSample(workerSample);
          }
        });
      } else if (message.ready) {
        port.postMessage(undefined);
      }
    });
  });
} finally {
  await worker.terminate();
}
assert(
  workerMemory.heapSizeLimitBytes !== undefined &&
    workerMemory.heapSizeLimitBytes > 0 &&
    workerMemory.heapUsed > 0,
);
if (observer.getOldGenerationAfterGcBytes) {
  assert(
    workerMemory.oldGenerationAfterGcBytes !== undefined &&
      workerMemory.oldGenerationAfterGcBytes > 0,
    "Missing worker native post-major-GC baseline",
  );
}
const report = {
  revision: values.revision,
  node: process.version,
  startedAt,
  finishedAt: Date.now(),
  sourceSha256: hashes,
  workloadSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  workerCount,
  workerScriptCount: scripts.length,
  rounds,
  iterations,
  exportMsPerSample: summarize(exportMs),
  exportCpuMsPerSample: (exportCpuUsage.user + exportCpuUsage.system) / 1_000 / rounds / iterations,
  renderedSeries: series.length,
  renderedBytes: Buffer.byteLength(rendered),
  gcDrainMs: summarize(drainMs),
  majorCollections,
  oldGenerationAfterGcBytes,
  workerMemory,
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
