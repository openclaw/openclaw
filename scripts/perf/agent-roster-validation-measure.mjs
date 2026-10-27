/**
 * Synthetic utility-warning owner benchmark (Node 26):
 * node --import ./scripts/tsx.mjs scripts/perf/agent-roster-validation-measure.mjs
 *   --subject ./src/status/utility-model-warnings.ts --mode timing --operations 200
 *
 * Run five alternating baseline/candidate pairs and four identical-source A/A
 * pairs. Use --mode allocation separately; use --trace-gc-nvp with --mode promotion
 * and sum GC records' promoted fields only between ROSTER_BEGIN and ROSTER_END. Never use
 * traced timing for gates. A frozen baseline module may be passed with --subject;
 * retain its relative imports against the same source tree. No Gateway or live state.
 *
 * Workload: 115 enabled plugins, 200 agents sharing an API utility provider, and a
 * fresh parsed config per change under the real metadata compatibility scope.
 * Each change invokes the production warning collector. Accept identical warnings
 * and fewer owner scans; use paired CPU/allocation, GC/op and latency under v5.6.
 * Tail percentiles below 200/1,000 observations are context for p95/p99 respectively.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    subject: { type: "string", default: "./src/status/utility-model-warnings.ts" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "200" },
    agents: { type: "string", default: "200" },
  },
});
const operations = Number(values.operations);
const agents = Number(values.agents);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Number.isSafeInteger(agents) && agents > 0);
assert(["timing", "allocation", "promotion", "counts"].includes(values.mode));
const root = await mkdtemp(path.join(tmpdir(), "openclaw-roster-measure-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_SKIP_CHANNELS = "1";
try {
  const { collectUtilityModelWarnings } = await import(pathToFileURL(path.resolve(values.subject)));
  const { createPluginMetadataSnapshotFixture } =
    await import("../../src/plugins/plugin-metadata.test-support.ts");
  const { withPluginMetadataSnapshotScope } =
    await import("../../src/plugins/current-plugin-metadata-snapshot.ts");
  const { finalizePluginMetadataSnapshot } =
    await import("../../src/plugins/plugin-metadata-snapshot.ts");
  const { resolveInstalledPluginIndexPolicyHash } =
    await import("../../src/plugins/installed-plugin-index-policy.ts");
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { model: "synthetic/model", utilityModel: "synthetic/small" },
      entries: Object.fromEntries(Array.from({ length: agents }, (_, i) => [`worker${i}`, {}])),
    },
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: 115 }, (_, i) => [`fixture${i}`, { enabled: true }]),
      ),
    },
  };
  const snapshot = createPluginMetadataSnapshotFixture(
    {
      plugins: Array.from({ length: 115 }, (_, i) => ({
        id: `fixture${i}`,
        rootDir: path.join(root, `fixture${i}`),
        providers: [`provider${i}`],
        cliBackends: [`cli${i}`],
        setup: { requiresRuntime: false },
      })),
    },
    resolveInstalledPluginIndexPolicyHash(config),
  );
  // Match the production owner: immutable indexes admit cached inventory facts.
  finalizePluginMetadataSnapshot(snapshot);
  const serialized = JSON.stringify(config);
  let descriptors = 0;
  if (values.mode === "counts") {
    for (const plugin of snapshot.plugins) {
      const ids = plugin.cliBackends;
      Object.defineProperty(plugin, "cliBackends", {
        get() {
          descriptors++;
          return ids;
        },
      });
    }
  }
  const run = () => {
    const changed = JSON.parse(serialized);
    const warnings = collectUtilityModelWarnings(changed, () => snapshot);
    assert.deepEqual(warnings, []);
  };
  await withPluginMetadataSnapshotScope(
    snapshot,
    async () => {
      for (let i = 0; i < 5; i++) {
        run();
      }
      descriptors = 0;
      const profiler = values.mode === "allocation" ? new Session() : undefined;
      if (profiler) {
        profiler.connect();
        await profiler.post("HeapProfiler.startSampling", {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const pauses = [];
      const observer = new PerformanceObserver((list) => pauses.push(...list.getEntries()));
      observer.observe({ entryTypes: ["gc"] });
      const loop = monitorEventLoopDelay({ resolution: 1 });
      loop.enable();
      await delay(5);
      loop.reset();
      const latencies = [];
      console.log("ROSTER_BEGIN");
      const cpuStart = process.threadCpuUsage();
      const started = performance.now();
      for (let i = 0; i < operations; i++) {
        const begin = performance.now();
        run();
        latencies.push(performance.now() - begin);
        await delay(1);
      }
      const cpu = process.threadCpuUsage(cpuStart);
      const elapsedMs = performance.now() - started;
      await delay(5);
      console.log("ROSTER_END");
      loop.disable();
      pauses.push(...observer.takeRecords());
      observer.disconnect();
      let allocatedBytes;
      if (profiler) {
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
        profiler.disconnect();
      }
      const summarize = (samples) => {
        const sorted = samples.toSorted((a, b) => a - b);
        const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
        return {
          count: sorted.length,
          totalMs: sorted.reduce((a, b) => a + b, 0),
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxMs: sorted.at(-1) ?? 0,
        };
      };
      console.log(
        JSON.stringify({
          subject: values.subject,
          mode: values.mode,
          agents,
          plugins: 115,
          operations,
          node: process.version,
          load: loadavg(),
          elapsedMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          allocatedBytes,
          descriptors,
          latency: summarize(latencies),
          loop: {
            count: loop.count,
            p95Ms: loop.percentile(95) / 1e6,
            p99Ms: loop.percentile(99) / 1e6,
            maxMs: loop.max / 1e6,
          },
          gc: summarize(pauses.map((entry) => entry.duration)),
          gcByKind: Object.fromEntries(
            [1, 4, 8].map((kind) => [
              kind,
              summarize(
                pauses.filter((entry) => entry.detail.kind === kind).map((entry) => entry.duration),
              ),
            ]),
          ),
        }),
      );
    },
    { config },
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
