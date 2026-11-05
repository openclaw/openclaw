/**
 * Real SQLite cron delivery owner benchmark: 10,000 sessions over four agents,
 * 64 distinct missing cron sources falling back to four current main routes.
 * No Gateway, model, plugin execution, network, or operator state is involved.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-delivery-context-measure.mjs \
 *   --owner .local/buf558/base-owner.ts --mode timing --operations 1000 \
 *   --output .local/buf558/base-timing.json
 * Repeat candidate/base in counterbalanced order; allocation uses a separate
 * --mode allocation arm sampling main-thread allocation including collected objects.
 * Process CPU includes worker CPU; mainCpuMsPerCall isolates the main thread.
 * Each arm creates fresh
 * isolated state alongside its output. Accept identical response hashes and
 * fewer worker reads with lower CPU/allocation; report p99 only at >=1000 calls.
 * --owner freezes only the delivery owner; dependencies come from this checkout.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "1000" },
    output: { type: "string" },
    sessions: { type: "string", default: "10000" },
  },
});
assert(values.output && global.gc, "--output and --expose-gc are required");
assert(["timing", "allocation"].includes(values.mode));
const operations = Number(values.operations),
  sessions = Number(values.sessions);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Number.isSafeInteger(sessions) && sessions >= 4);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), "delivery-state-"));
const configPath = path.join(root, "openclaw.json");
const agents = ["main", "ops", "research", "review"];
const cfg = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: Object.fromEntries(agents.map((id) => [id, { workspace: path.join(root, id) }])),
  },
  plugins: { enabled: false },
};
await writeFile(configPath, JSON.stringify(cfg));
process.env = { ...createGatewayBenchEnv(root, configPath, { startupTrace: false }), TMPDIR: root };
const ownerUrl = new URL(
  "../../src/cron/isolated-agent/delivery-target-context.ts",
  import.meta.url,
).href;
const ownerSource = readFileSync(values.owner ?? new URL(ownerUrl), "utf8");
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl) {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: transformSync(ownerSource, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const agentDb = await import("../../src/state/openclaw-agent-db.js");
const stateDb = await import("../../src/state/openclaw-state-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { normalizeSessionDeliveryState } =
  await import("../../src/utils/delivery-context.shared.js");
setRuntimeConfigSnapshot(cfg);
try {
  const fixtureStart = performance.now();
  for (const [agentIndex, agentId] of agents.entries()) {
    const count =
      Math.floor(sessions / agents.length) + (agentIndex < sessions % agents.length ? 1 : 0);
    for (let start = 0; start < count; start += 100) {
      agentDb.runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = start; index < Math.min(count, start + 100); index++) {
            const key = `agent:${agentId}:${index === 0 ? "main" : `subagent:synthetic-${index}`}`;
            writeSessionEntry(database, key, {
              sessionId: `${agentId}-${index}`,
              updatedAt: 1800000000000,
              label: "Synthetic unrelated session metadata ".repeat(16),
              ...(index === 0
                ? {
                    delivery: normalizeSessionDeliveryState({
                      context: {
                        channel: "telegram",
                        to: `synthetic-${agentId}`,
                        accountId: "synthetic",
                        threadId: 0,
                      },
                    }),
                  }
                : {}),
            });
          }
        },
        { agentId },
      );
      await nextTurn();
    }
  }
  const fixtureMs = performance.now() - fixtureStart;
  const { readCronDeliveryTargetContexts } = await import(ownerUrl);
  const requests = Array.from({ length: 64 }, (_, index) => ({
    agentId: agents[index % 4],
    sessionKey: `agent:${agents[index % 4]}:cron:missing-${index}`,
  }));
  const run = () => readCronDeliveryTargetContexts(cfg, requests);
  const initial = await run();
  for (const [index, result] of initial.entries()) {
    assert(result.ok);
    assert.equal(result.value.usedSharedMainFallback, true);
    assert.equal(result.value.main?.delivery?.context?.to, `synthetic-${requests[index].agentId}`);
  }
  const wireSha256 = createHash("sha256").update(JSON.stringify(initial)).digest("hex");
  for (let i = 0; i < 10; i++) {
    await run();
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let gcMs = 0,
    gcCount = 0,
    maxGcMs = 0;
  const gc = new PerformanceObserver((entries) => {
    for (const item of entries.getEntries()) {
      gcMs += item.duration;
      gcCount++;
      maxGcMs = Math.max(maxGcMs, item.duration);
    }
  });
  gc.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const before = process.memoryUsage(),
    hostLoad = loadavg(),
    times = [];
  const cpu = process.cpuUsage(),
    threadCpu = process.threadCpuUsage();
  const started = performance.now();
  for (let i = 0; i < operations; i++) {
    const start = performance.now();
    const result = await run();
    times.push(performance.now() - start);
    assert.equal(result.length, 64);
  }
  const elapsedMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpu),
    mainCpu = process.threadCpuUsage(threadCpu);
  const after = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  loop.disable();
  gc.disconnect();
  const sampled = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + sampled(child), 0);
  const sampledBytes =
    values.mode === "allocation"
      ? sampled((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : null;
  if (values.mode === "allocation") {
    inspector.disconnect();
  }
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(await run()))
      .digest("hex"),
    wireSha256,
  );
  global.gc();
  await nextTurn();
  times.sort((a, b) => a - b);
  const report = {
    mode: values.mode,
    operations,
    jobs: requests.length,
    agents: agents.length,
    sessions,
    fixtureMs,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    wireSha256,
    hostLoad,
    elapsedMs,
    processCpuMsPerCall: (processCpu.user + processCpu.system) / 1000 / operations,
    mainCpuMsPerCall: (mainCpu.user + mainCpu.system) / 1000 / operations,
    latency: {
      count: times.length,
      p50Ms: times[Math.ceil(times.length * 0.5) - 1],
      p99Ms: times[Math.ceil(times.length * 0.99) - 1],
      maxMs: times.at(-1),
    },
    sampledBytesPerCall: sampledBytes === null ? null : sampledBytes / operations,
    gc: { ms: gcMs, count: gcCount, maxMs: maxGcMs, msPerMinute: (gcMs / elapsedMs) * 60000 },
    loop: { count: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
    memory: { before, after, afterGc: process.memoryUsage() },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  hook.deregister();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  await stateDb.closeOpenClawStateDatabaseAsync();
  await rm(root, { recursive: true, force: true });
}
