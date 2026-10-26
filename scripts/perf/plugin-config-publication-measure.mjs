// Capture and first-read runtime/source plugin policy with 40 plugins per snapshot.
// Build each reviewed revision: node scripts/perf/plugin-config-publication-measure.mjs --build ROOT BUNDLE
// Measure: node --expose-gc scripts/perf/plugin-config-publication-measure.mjs BUNDLE timing|allocation [2000] [capture|sdk|mixed]
// Each operation includes capture/cloning, then the selected core and SDK reads
// for both frozen revisions (default mixed). Compare alternating baseline/candidate
// runs, separating allocation instrumentation from timing; this is owner-level proof,
// not a whole-Gateway latency measurement. Keep HOME/state isolated on benchmark hosts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as turn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

if (process.argv[2] === "--build") {
  const [sourceRoot, output] = process.argv.slice(3);
  assert(sourceRoot && output, "Usage: --build ROOT BUNDLE");
  const root = path.resolve(sourceRoot);
  const { build } = await import("esbuild");
  await build({
    stdin: {
      contents: `
        export { createPluginActivationSource } from './src/plugins/config-state.js';
        export { captureRuntimeConfigWithSource, getRuntimeConfigCapture } from './src/config/runtime-config-capture-state.js';
        export { resolvePluginConfigObject } from './src/plugin-sdk/plugin-config-runtime.js';
      `,
      resolveDir: root,
      loader: "ts",
    },
    absWorkingDir: root,
    tsconfig: path.join(root, "tsconfig.json"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.resolve(output),
  });
  process.exit(0);
}

const [bundle, mode, count = "2000", workload = "mixed"] = process.argv.slice(2);
assert(
  bundle && ["timing", "allocation"].includes(mode),
  "Usage: BUNDLE timing|allocation [2000] [capture|sdk|mixed]",
);
assert(["capture", "sdk", "mixed"].includes(workload));
assert(global.gc, "Run with --expose-gc");
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced runs");
const operations = Number(count);
assert(Number.isSafeInteger(operations) && operations > 0);
const owner = await import(pathToFileURL(path.resolve(bundle)).href);
const configFor = (revision) => ({
  plugins: {
    allow: Array.from({ length: 40 }, (_, i) => `plugin-${i}`),
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        ` PLUGIN-${i} `,
        {
          enabled: i !== 0 || revision === 2,
          config: { revision, value: i },
          hooks: { allowPromptInjection: false, timeouts: { before_agent_start: 1000 } },
          llm: { allowedModels: ["example/model"], allowModelOverride: false },
        },
      ]),
    ),
  },
});
const sourceConfig = configFor(1);
const runtimeConfig = configFor(2);
let checksum = 0;
function operation() {
  const captured = owner.captureRuntimeConfigWithSource(runtimeConfig, sourceConfig);
  const capturedSource = owner.getRuntimeConfigCapture(captured).source;
  if (workload === "capture") {
    checksum +=
      captured.plugins.entries[" PLUGIN-0 "].config.revision * 10 +
      capturedSource.plugins.entries[" PLUGIN-0 "].config.revision;
    return;
  }
  const runtimePayload = owner.resolvePluginConfigObject(captured, "plugin-0");
  const sourcePayload = owner.resolvePluginConfigObject(capturedSource, "plugin-0");
  checksum += runtimePayload.revision * 10 + sourcePayload.revision;
  if (workload === "mixed") {
    const runtime = owner.createPluginActivationSource({ config: captured }).plugins;
    const source = owner.createPluginActivationSource({ config: capturedSource }).plugins;
    checksum +=
      Number(runtime.entries["plugin-0"].enabled) +
      Number(source.entries["plugin-0"].enabled) +
      Number(runtime.entries["plugin-0"].config === runtimePayload) +
      Number(source.entries["plugin-0"].config === sourcePayload);
  }
}
const expectedPerOp = workload === "mixed" ? 24 : 21;
for (let i = 0; i < 100; i++) {
  operation();
}
assert.equal(checksum, 100 * expectedPerOp);
global.gc();
await turn();
const collections = [];
const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const session = new Session();
if (mode === "allocation") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadStart = loadavg();
checksum = 0;
const cpuStart = process.cpuUsage();
const startedAt = performance.now();
for (let i = 0; i < operations; i++) {
  operation();
  if ((i + 1) % 100 === 0) {
    await turn();
  }
}
const endedAt = performance.now();
const cpu = process.cpuUsage(cpuStart);
const memory = process.memoryUsage();
await turn();
await turn();
observer.disconnect();
let allocatedBytes;
if (mode === "allocation") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  const sum = (node) =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  session.disconnect();
}
assert.equal(checksum, operations * expectedPerOp);
const gc = collections.filter((entry) => entry.startTime >= startedAt && entry.startTime < endedAt);
const gcMs = gc.reduce((total, entry) => total + entry.duration, 0);
const cpuMs = (cpu.user + cpu.system) / 1000;
console.log(
  JSON.stringify({
    bundle: path.resolve(bundle),
    bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
    mode,
    workload,
    operations,
    captures: operations * 2,
    policyReads: operations * (workload === "capture" ? 0 : workload === "sdk" ? 2 : 4),
    checksum,
    wallMs: endedAt - startedAt,
    cpuMs,
    cpuUsPerOp: (cpuMs * 1000) / operations,
    allocatedBytes,
    allocatedBytesPerOp: allocatedBytes === undefined ? undefined : allocatedBytes / operations,
    gc: {
      count: gc.length,
      totalMs: gcMs,
      msPerOp: gcMs / operations,
      maxMs: Math.max(0, ...gc.map((entry) => entry.duration)),
      byKind: Object.fromEntries(
        [...new Set(gc.map((entry) => entry.detail.kind))].map((kind) => {
          const entries = gc.filter((entry) => entry.detail.kind === kind);
          return [
            kind,
            {
              count: entries.length,
              totalMs: entries.reduce((total, entry) => total + entry.duration, 0),
              maxMs: Math.max(0, ...entries.map((entry) => entry.duration)),
            },
          ];
        }),
      ),
    },
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    hostLoadStart,
    hostLoadEnd: loadavg(),
  }),
);
