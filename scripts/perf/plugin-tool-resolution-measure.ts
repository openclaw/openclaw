/**
 * Resolve a completed generation's 40 synthetic plugins (80 tools) across 64 sessions.
 * Run the identical script on both revisions, counterbalancing order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-tool-resolution-measure.ts timing 3000
 * Repeat with allocation for a separate sampled-allocation pass. Setup and warmup are excluded.
 * Reports main-thread/process CPU, assembly latency, GC, RSS/heap, host load, and work counts.
 * This is owner-level assembly proof, not a whole-Gateway or session-start latency claim.
 * All state is synthetic and task-local; no running Gateway or provider is contacted.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";

const [mode = "timing", rawIterations = "3000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const ownerSha256 = createHash("sha256")
  .update(await fs.readFile(new URL("../../src/plugins/tools.ts", import.meta.url)))
  .digest("hex");
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/plugin-tool-resolution-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const ids = Array.from({ length: 40 }, (_, index) => `synthetic-${String(index).padStart(2, "0")}`);
const pluginPaths: string[] = [];
const toolNames = ids.flatMap((id) => [`${id}_read`, `${id}_write`]);
const inspector = new Session();
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), collections, measuredStart, measuredEnd),
);
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((total, ms) => total + ms, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
try {
  for (const id of ids) {
    const dir = path.join(root, id);
    await fs.mkdir(dir);
    const names = [`${id}_read`, `${id}_write`];
    await fs.writeFile(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        contracts: { tools: names },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    const file = path.join(dir, "index.cjs");
    await fs.writeFile(
      file,
      `let factoryCalls = 0;
      module.exports = { id: ${JSON.stringify(id)}, register(api) {
        api.registerTool({ contextVersion: 2, create(ctx) {
          factoryCalls++;
          return ${JSON.stringify(names)}.map(name => ({
            name, label: name, description: ctx.runId + ':' + ctx.sessionKey + ':' + factoryCalls,
            parameters: { type: 'object', properties: {} },
            async execute() {
              ctx.assertInvocationCurrent();
              return { content: [{ type: 'text', text: ctx.runId }], details: {} };
            }
          }));
        } }, { names: ${JSON.stringify(names)}, workspaceAccess: false });
      } };`,
    );
    pluginPaths.push(file);
  }
  const [
    { loadOpenClawPluginsAsync },
    { createPluginCache, withPluginCache },
    { getPluginRuntimeLoadContext, buildPluginRuntimeLoadOptions },
    { resolvePluginRuntimeLoadContext },
    { resolvePluginTools },
  ] = await Promise.all([
    import("../../src/plugins/loader-runtime-load.js"),
    import("../../src/plugins/plugin-cache.js"),
    import("../../src/plugins/runtime/load-context.js"),
    import("../../src/plugins/runtime/load-context.resolve.js"),
    import("../../src/plugins/tools.js"),
  ]);
  await using cache = createPluginCache();
  const config = {
    plugins: {
      allow: ids,
      load: { paths: pluginPaths },
      entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
      slots: { memory: "none" },
    },
  };
  const registry = await withPluginCache(cache, () => {
    const context = resolvePluginRuntimeLoadContext({
      config,
      workspaceDir: root,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    return loadOpenClawPluginsAsync(buildPluginRuntimeLoadOptions(context, { activate: false }));
  });
  assert.deepEqual(
    registry.plugins.map(({ id, status }) => [id, status]),
    ids.map((id) => [id, "loaded"]),
  );
  const loadContext = getPluginRuntimeLoadContext(registry);
  assert(loadContext?.loaderCacheIdentity, "loader must complete the generation");
  const metadataSnapshot = loadContext.metadataSnapshot;
  assert(metadataSnapshot, "loader must retain manifest metadata");
  const preparedRuntime = { registry, loadContext, metadataSnapshot };
  const resolve = (index: number) => {
    const runId = `run-${index}`;
    const sessionKey = `agent:main:synthetic-${index % 64}`;
    let current = true;
    const tools = resolvePluginTools({
      context: { config, workspaceDir: root, sessionKey, sessionId: sessionKey, runId },
      preparedRuntime,
      runtimeRegistry: registry,
      toolAllowlist: ["group:plugins"],
      assertInvocationCurrent() {
        assert(current, "turn is no longer current");
      },
    });
    return {
      tools,
      description: `${runId}:${sessionKey}:${index + 2}`,
      close: () => {
        current = false;
      },
    };
  };
  // Exercise real callbacks once, then prove a retained tool cannot follow the next turn.
  const first = resolve(-1);
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    toolNames,
  );
  assert.equal(first.tools[0]?.description, first.description);
  assert.equal((await first.tools[0]!.execute("preflight", {})).content[0]?.type, "text");
  first.close();
  await assert.rejects(() => first.tools[0]!.execute("retired", {}), /no longer current/);
  for (let index = 0; index < 100; index++) {
    const turn = resolve(index);
    assert.equal(turn.tools.length, toolNames.length);
    turn.close();
  }
  global.gc();
  await nextTurn();
  const memoryBefore = process.memoryUsage();
  const hostLoadBefore = loadavg();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const latencies: number[] = [];
  let lastTurn: ReturnType<typeof resolve> | undefined;
  measuredStart = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const turn = resolve(index + 100);
    lastTurn = turn;
    latencies.push(performance.now() - started);
    assert.equal(turn.tools.length, toolNames.length);
    assert.equal(turn.tools[0]?.description, turn.description);
    assert.equal(turn.tools.at(-1)?.description, turn.description);
    turn.close();
    if (index % 100 === 99) {
      await nextTurn();
    }
  }
  measuredEnd = performance.now();
  const elapsedCpu = process.threadCpuUsage(cpu);
  const elapsedProcessCpu = process.cpuUsage(processCpu);
  const memoryAfter = process.memoryUsage();
  assert(lastTurn);
  for (const tool of lastTurn.tools) {
    assert.equal(tool.description, lastTurn.description);
  }
  const factoryCalls = lastTurn.tools
    .filter((_, index) => index % 2 === 0)
    .reduce((sum, tool) => sum + Number(tool.description.split(":").at(-1)) - 101, 0);
  assert.equal(factoryCalls, iterations * ids.length);
  const sampledBytes =
    mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
  await nextTurn();
  recordGcCollections(observer.takeRecords(), collections, measuredStart, measuredEnd);
  observer.disconnect();
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  console.log(
    JSON.stringify({
      mode,
      node: process.version,
      ownerSha256,
      iterations,
      plugins: ids.length,
      toolsPerTurn: toolNames.length,
      sessions: 64,
      factoryCalls,
      mainThreadCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
      processCpuMs: (elapsedProcessCpu.user + elapsedProcessCpu.system) / 1000,
      elapsedMs: measuredEnd - measuredStart,
      assemblyLatency: distribution(latencies),
      sampledBytes,
      sampledBytesPerTurn: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc:
        mode === "timing"
          ? {
              total: gc(),
              minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
              major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
            }
          : undefined,
      memoryBefore,
      memoryAfter,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
