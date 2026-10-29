/**
 * Native Code Mode eviction probe; synthetic sessions, no Gateway or external tools.
 * Run five interleaved pairs against base/candidate owners with identical built workers:
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-worker-burst-measure.ts \
 *   <built-root> [executor-module=src/agents/code-mode-node.ts] [rounds=125] [width=8]
 * The built root must contain dist/agents/code-mode-node.worker.js from the tested source.
 * Each burst parks all sessions at a mock tool before releasing them; three tool calls
 * exercise the real worker bridge. GC reclaimed bytes are not total allocation, since
 * terminating a worker can discard an uncollected heap. No forced GC is performed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { CodeModeExecutor } from "../../src/agents/code-mode-executor-types.js";

const builtRoot = path.resolve(process.argv[2]!);
const executorFile = path.resolve(process.argv[3] ?? "src/agents/code-mode-node.ts");
const rounds = Number(process.argv[4] ?? 125);
const width = Number(process.argv[5] ?? 8);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(Number.isSafeInteger(width) && width > 0 && width <= 16);
const workerFile = path.join(builtRoot, "dist/agents/code-mode-node.worker.js");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const workerHash = digest(workerFile);
const executorHash = digest(executorFile);
const sourceEntrypoints = new URL(
  "../../src/infra/runtime-process-entrypoints.ts",
  import.meta.url,
);
const builtEntrypoints = pathToFileURL(
  path.join(builtRoot, "dist/infra/runtime-process-entrypoints.js"),
);
// Use the build's declaration module, just as the native-worker test harness does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === sourceEntrypoints.href
      ? { ...resolved, url: builtEntrypoints.href }
      : resolved;
  },
});
const { prepareCodeModeNodeCatalog } = await import("../../src/agents/code-mode-node-input.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { getTrackedWorkerLifecycleSnapshot, sampleTrackedWorkerMemory, setTrackedWorkerGcObserver } =
  await import("../../src/infra/worker-cpu.js");
const { LegacyPluginSdkResourceHost } =
  await import("../../src/plugins/legacy-sdk-resource-host.js");
const { createDeferredCore } = await import("../../src/shared/deferred.js");
const { resolveRuntimeProcessEntrypointUrl } =
  await import("../../src/infra/runtime-process-url.js");
assert.equal(
  resolveRuntimeProcessEntrypointUrl("codeModeNode").href,
  pathToFileURL(workerFile).href,
);
const { nodeCodeModeExecutor }: { nodeCodeModeExecutor: CodeModeExecutor } = await import(
  pathToFileURL(executorFile).href
);
const script = "code-mode-node.worker.js";
const config = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 1024,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 10 * 1024 * 1024,
};
const catalog = prepareCodeModeNodeCatalog({
  catalog: Array.from({ length: 160 }, (_, index) => ({
    name: `tool_${index}`,
    callableName: `tool_${index}`,
    source: "openclaw",
    description: "Synthetic tool description ".repeat(8),
  })),
  namespaces: [],
});
const host = new LegacyPluginSdkResourceHost();
const scheduler = new GatewayScheduler();
host.bindScheduler(scheduler);
const roles = [
  "dashboard",
  "dashboard",
  "dashboard",
  "dashboard",
  "subagent",
  "subagent",
  "cron",
  "cron",
];
const latencies: number[] = [];
const loadStart = loadavg();
let bridgeCalls = 0;
let aggregateWorkerHeapHighWaterBytes = 0;
let perWorkerHeapHighWaterBytes = 0;
let idleWorkerHeapHighWaterBytes = 0;
let rssHighWaterBytes = process.memoryUsage().rss;
let maxIdleWorkers = 0;
let gcMs = 0;
let reclaimedBytes = 0;
setTrackedWorkerGcObserver((samples) => {
  for (const sample of samples) {
    gcMs += sample.durationMs;
    reclaimedBytes += sample.reclaimedBytes ?? 0;
  }
});
const keepAlive = globalThis.setInterval(() => {}, 1000);
const cpuStart = process.cpuUsage();
const threadCpuStart = process.threadCpuUsage();
const startedAt = performance.now();
try {
  for (let round = 0; round < rounds; round++) {
    const barrier = createDeferredCore();
    const heaps: number[] = [];
    const tasks = Array.from({ length: width }, async (_, slot) => {
      const session = `${roles[slot % roles.length]}-${slot}`;
      const marker = `${session}:${round}`;
      const at = performance.now();
      let calls = 0;
      const source = `
        const previous = typeof previousCell;
        globalThis.previousCell = ${JSON.stringify(marker)};
        let reply;
        for (let call = 0; call < 3; call++) reply = await tool_0({ session: ${JSON.stringify(session)}, round: ${round}, call });
        return { previous, marker: previousCell, reply };
      `;
      const result = await host.run(() =>
        nodeCodeModeExecutor.execute(
          { kind: "exec", source, config, ...catalog },
          {
            timeoutMs: config.timeoutMs,
            inlineHost: {
              async onBoundary(boundary, context) {
                calls++;
                bridgeCalls++;
                if (calls === 1) {
                  heaps.push(boundary.memoryUsedBytes);
                  perWorkerHeapHighWaterBytes = Math.max(perWorkerHeapHighWaterBytes, ...heaps);
                  if (heaps.length === width) {
                    aggregateWorkerHeapHighWaterBytes = Math.max(
                      aggregateWorkerHeapHighWaterBytes,
                      heaps.reduce((sum, heap) => sum + heap, 0),
                    );
                    rssHighWaterBytes = Math.max(rssHighWaterBytes, process.memoryUsage().rss);
                    barrier.resolve();
                  }
                  await barrier.promise;
                }
                assert.equal(boundary.pendingRequests.length, 1);
                const request = boundary.pendingRequests[0]!;
                assert.equal(request.method, "callValue");
                assert.equal(request.args[0], "tool_0");
                assert.deepEqual(request.args[1], { session, round, call: calls - 1 });
                return {
                  kind: "continue",
                  timeoutMs: context.maxTimeoutMs,
                  pendingRequests: [],
                  settledRequests: [
                    { id: request.id, ok: true, json: JSON.stringify(request.args[1]) },
                  ],
                };
              },
            },
          },
        ),
      );
      assert.equal(calls, 3);
      assert.equal(result.status, "completed", JSON.stringify(result));
      if (result.status !== "completed") {
        throw new Error("Incomplete synthetic cell");
      }
      assert.equal(
        result.value?.json,
        JSON.stringify({ previous: "undefined", marker, reply: { session, round, call: 2 } }),
      );
      latencies.push(performance.now() - at);
    });
    await Promise.all(tasks);
    sampleTrackedWorkerMemory({ refresh: true });
    // Observe idle heaps after the native memory-port replies have had a turn.
    await setTimeout(20);
    await setImmediate();
    const memory = sampleTrackedWorkerMemory({ refresh: false });
    const idleHeaps = memory.workerHeaps.filter((worker) => worker.script === script);
    maxIdleWorkers = Math.max(maxIdleWorkers, idleHeaps.length);
    const idleBytes = idleHeaps.reduce((sum, worker) => sum + worker.heapUsed, 0);
    idleWorkerHeapHighWaterBytes = Math.max(idleWorkerHeapHighWaterBytes, idleBytes);
    aggregateWorkerHeapHighWaterBytes = Math.max(aggregateWorkerHeapHighWaterBytes, idleBytes);
    perWorkerHeapHighWaterBytes = Math.max(
      perWorkerHeapHighWaterBytes,
      ...idleHeaps.map((worker) => worker.heapUsed),
    );
    rssHighWaterBytes = Math.max(rssHighWaterBytes, process.memoryUsage().rss);
  }
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const mainCpu = process.threadCpuUsage(threadCpuStart);
  const beforeClose = getTrackedWorkerLifecycleSnapshot();
  await host.close();
  const afterClose = getTrackedWorkerLifecycleSnapshot();
  latencies.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      executorHash,
      workerHash,
      rounds,
      width,
      executions: latencies.length,
      bridgeCalls,
      reuseKeys: 1,
      loadStart,
      loadEnd: loadavg(),
      wallMs,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      medianMs: latencies[Math.floor(latencies.length / 2)],
      p95Ms: latencies[Math.floor(latencies.length * 0.95)],
      p99Ms: latencies[Math.floor(latencies.length * 0.99)],
      aggregateWorkerHeapHighWaterBytes,
      perWorkerHeapHighWaterBytes,
      idleWorkerHeapHighWaterBytes,
      maxIdleWorkers,
      rssHighWaterBytes,
      gcMs,
      reclaimedBytes,
      lifecycleBeforeClose: beforeClose.workerLifecycle.filter((entry) => entry.script === script),
      lifecycle: afterClose.workerLifecycle.filter((entry) => entry.script === script),
      taskMetrics: afterClose.workerTaskMetrics.filter((entry) => entry.script === script),
    }),
  );
} finally {
  await host.close();
  await scheduler.stop();
  setTrackedWorkerGcObserver(undefined);
  clearInterval(keepAlive);
}
