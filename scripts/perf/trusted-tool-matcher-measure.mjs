// Measure real trusted-policy dispatch with 40 synthetic plugin policies.
// Build each revision: node scripts/perf/trusted-tool-matcher-measure.mjs --build ROOT BUNDLE
// Run: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trusted-tool-matcher-measure.mjs BUNDLE timing|allocation [2000]
// Each bundle snapshots only trusted-tool-policy.ts; its unchanged dependencies
// resolve from the source checkout through tsx. Keep that dependency graph fixed.
// Half the policies match each call; all use multi-name canonical matchers.
// Fixtures and warmup precede measurement. No session key, persistence, Gateway,
// credentials, or provider calls are used. Keep HOME/state isolated on benchmark hosts.
// Alternate baseline/candidate timing passes; allocation passes use 4 KiB sampling
// including collected objects and must not supply timing/GC acceptance evidence.
// This measures the production owner, not whole-Gateway latency. A pass fails if
// dispatch semantics change or measured work exceeds 25 seconds; lower count if needed.
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
      contents: `export { runTrustedToolPolicies } from './src/plugins/trusted-tool-policy.js';`,
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
    plugins: [
      {
        name: "retain-source-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (
              args.pluginData?.resolvingDependency ||
              args.importer !== path.join(root, "src/plugins/trusted-tool-policy.ts")
            ) {
              return undefined;
            }
            const resolved = await builder.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: { resolvingDependency: true },
            });
            return { path: resolved.path, external: true, errors: resolved.errors };
          });
        },
      },
    ],
  });
  process.exit(0);
}

const [bundle, mode, count = "2000"] = process.argv.slice(2);
assert(bundle && ["timing", "allocation"].includes(mode), "Usage: BUNDLE timing|allocation [2000]");
assert(global.gc, "Run with --expose-gc");
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced runs");
const operations = Number(count);
assert(Number.isSafeInteger(operations) && operations > 0);
const { runTrustedToolPolicies } = await import(pathToFileURL(path.resolve(bundle)).href);
const policyCount = 40;
const evaluations = new Uint32Array(policyCount);
const registry = {
  trustedToolPolicies: Array.from({ length: policyCount }, (_, index) => ({
    pluginId: `synthetic-policy-${index}`,
    source: "synthetic-benchmark",
    policy: {
      id: `policy-${index}`,
      description: "Synthetic matcher dispatch workload",
      matcher:
        index % 2 === 0
          ? ["apply_patch", "edit", "exec", "read", "write"]
          : ["browser", "message", "sessions_list", "web_fetch", "web_search"],
      evaluate() {
        evaluations[index] += 1;
      },
    },
  })),
};
const event = { toolName: "exec", params: { command: "synthetic input only" } };
const context = { toolName: "exec", agentId: "synthetic-agent" };
const options = { registry };
async function operation() {
  assert.equal(await runTrustedToolPolicies(event, context, options), undefined);
}
function verifyEvaluations(expectedOperations) {
  for (let index = 0; index < policyCount; index++) {
    assert.equal(evaluations[index], index % 2 === 0 ? expectedOperations : 0);
  }
}
for (let i = 0; i < 100; i++) {
  await operation();
}
verifyEvaluations(100);
evaluations.fill(0);
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
const processCpuStart = process.cpuUsage();
const threadCpuStart = process.threadCpuUsage?.();
const startedAt = performance.now();
for (let i = 0; i < operations; i++) {
  await operation();
  if ((i + 1) % 100 === 0) {
    assert(
      performance.now() - startedAt < 25_000,
      "Pass exceeded 25 seconds; lower operation count",
    );
    await turn();
  }
}
const endedAt = performance.now();
const processCpu = process.cpuUsage(processCpuStart);
const threadCpu = threadCpuStart ? process.threadCpuUsage(threadCpuStart) : undefined;
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
verifyEvaluations(operations);
global.gc();
const retainedHeapBytes = process.memoryUsage().heapUsed;
const gc = collections.filter((entry) => entry.startTime >= startedAt && entry.startTime < endedAt);
const gcSummary = (entries) => ({
  count: entries.length,
  totalMs: entries.reduce((total, entry) => total + entry.duration, 0),
  maxMs: Math.max(0, ...entries.map((entry) => entry.duration)),
});
const wallMs = endedAt - startedAt;
const processCpuMs = (processCpu.user + processCpu.system) / 1000;
const mainThreadCpuMs = threadCpu ? (threadCpu.user + threadCpu.system) / 1000 : undefined;
const totalGc = gcSummary(gc);
console.log(
  JSON.stringify({
    bundle: path.resolve(bundle),
    bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
    mode,
    operations,
    policiesPerOperation: policyCount,
    policyEvaluations: evaluations.reduce((total, value) => total + value, 0),
    wallMs,
    processCpuMs,
    processCpuUsPerOp: (processCpuMs * 1000) / operations,
    mainThreadCpuMs,
    mainThreadCpuUsPerOp:
      mainThreadCpuMs === undefined ? undefined : (mainThreadCpuMs * 1000) / operations,
    allocatedBytes,
    allocatedBytesPerOp: allocatedBytes === undefined ? undefined : allocatedBytes / operations,
    gc: {
      ...totalGc,
      msPerOp: totalGc.totalMs / operations,
      msPerMinute: (totalGc.totalMs * 60_000) / wallMs,
      byKind: Object.fromEntries(
        [...new Set(gc.map((entry) => entry.detail.kind))].map((kind) => [
          kind,
          gcSummary(gc.filter((entry) => entry.detail.kind === kind)),
        ]),
      ),
    },
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    retainedHeapBytes,
    hostLoadStart,
    hostLoadEnd: loadavg(),
  }),
);
