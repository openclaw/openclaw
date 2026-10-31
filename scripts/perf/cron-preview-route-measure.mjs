/**
 * Cron delivery route owner: 200 jobs/page, four agents, 40 loaded synthetic plugins.
 * Prepared session contexts isolate route work after cron.list's session read batch;
 * this is not a Gateway, database, or model throughput measurement.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-preview-route-measure.mjs \
 *   --base .local/cron-preview/base.ts --candidate .local/cron-preview/candidate.ts \
 *   --mode timing --operations 20 --pairs 5 --output .local/cron-preview/timing.json
 * Both frozen owners load once against shared dependencies. Serial pairs alternate
 * AB/BA order. Run --mode allocation separately (includes collected objects).
 * Accept identical wire hashes, fewer route calls, and lower CPU/allocation.
 * Tail percentiles include their sample counts.
 * Only delivery-target.ts varies; all dependencies come from this checkout.
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
import { summarizeDurationDistribution } from "../lib/perf-duration-distribution.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    pairs: { type: "string", default: "5" },
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "20" },
    output: { type: "string" },
  },
});
assert(
  values.base && values.candidate && values.output && global.gc,
  "--base, --candidate, --output and --expose-gc are required",
);
assert(["timing", "allocation"].includes(values.mode));
assert(!process.execArgv.some((arg) => arg.startsWith("--trace-gc")), "Use untraced timing");
const operations = Number(values.operations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), "route-state-"));
const configPath = path.join(root, "openclaw.json");
const agents = ["main", "ops", "research", "review"];
const cfg = {
  agents: {
    entries: Object.fromEntries(agents.map((agentId) => [agentId, {}])),
  },
  channels: {},
  plugins: { enabled: false },
};
await writeFile(configPath, JSON.stringify(cfg));
process.env = { ...createGatewayBenchEnv(root, configPath, { startupTrace: false }), TMPDIR: root };
const ownerUrl = new URL("../../src/cron/isolated-agent/delivery-target.ts", import.meta.url).href;
const owners = ["base", "candidate"].map((side) => ({
  side,
  url: `${ownerUrl}?cron-preview-owner=${side}`,
  source: readFileSync(values[side], "utf8"),
}));
const hook = registerHooks({
  load(url, context, nextLoad) {
    const owner = owners.find((entry) => entry.url === url);
    if (!owner) {
      return nextLoad(url, context);
    }
    owner.loaded = true;
    return {
      format: "module",
      source: transformSync(owner.source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const { createForumTargetTestPlugin, createTargetsTestRegistry } =
  await import("../../src/infra/outbound/targets.test-helpers.js");
const { createChannelTestPluginBase } = await import("../../src/test-utils/channel-plugins.js");
const { setActivePluginRegistry, resetPluginRuntimeStateForTest } =
  await import("../../src/plugins/runtime.js");
const { normalizeSessionDeliveryState } =
  await import("../../src/utils/delivery-context.shared.js");
for (const owner of owners) {
  owner.resolveDeliveryTarget = (await import(owner.url)).resolveDeliveryTarget;
  assert(owner.loaded, `Frozen ${owner.side} owner was not loaded`);
}
let routeCalls = 0;
const forum = createForumTargetTestPlugin();
const resolveRoute = forum.messaging.resolveOutboundSessionRoute;
forum.messaging.resolveOutboundSessionRoute = (params) => {
  routeCalls++;
  return resolveRoute(params);
};
setActivePluginRegistry(
  createTargetsTestRegistry([
    forum,
    ...Array.from({ length: 39 }, (_, index) =>
      createChannelTestPluginBase({ id: `synthetic-${index}` }),
    ),
  ]),
);
const requests = Array.from({ length: 200 }, (_, index) => {
  const agentId = agents[index % agents.length];
  const sessionKey = `agent:${agentId}:dashboard:synthetic-${index}`;
  const variant = index % 4;
  const to = `room:synthetic-${index}`;
  const threadId = variant === 1 ? undefined : 0;
  return {
    agentId,
    payload: { channel: "forum", sessionKey, ...(variant === 0 ? {} : { to }) },
    options: {
      dryRun: true,
      inheritSessionThread: variant !== 2,
      sessionContext: {
        mainSessionKey: `agent:${agentId}:main`,
        rawSessionKey: sessionKey,
        threadSessionKey: sessionKey,
        usedSharedMainFallback: false,
        main: {
          sessionId: `synthetic-${index}`,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context: { channel: "forum", to, threadId } }),
        },
      },
    },
    expected: { to, threadId: variant === 1 || variant === 2 ? undefined : 0 },
  };
});
const run = (owner) =>
  Promise.all(
    requests.map(({ agentId, payload, options }) =>
      owner.resolveDeliveryTarget(cfg, agentId, payload, options),
    ),
  );
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function measure(owner, pair, order, wireSha256) {
  const inspector = new Session();
  const gcByKind = {};
  const gc = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      (gcByKind[entry.detail.kind] ??= []).push(entry.duration);
    }
  });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  try {
    global.gc();
    await nextTurn();
    await nextTurn();
    if (values.mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    routeCalls = 0;
    gc.observe({ entryTypes: ["gc"] });
    loop.enable();
    const before = process.memoryUsage();
    const hostLoad = loadavg();
    const times = [];
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const started = performance.now();
    for (let index = 0; index < operations; index++) {
      const start = performance.now();
      await run(owner);
      times.push(performance.now() - start);
      await nextTurn();
    }
    const elapsedMs = performance.now() - started;
    const cpuUsed = process.cpuUsage(cpu);
    const threadUsed = process.threadCpuUsage(thread);
    const after = process.memoryUsage();
    const callsPerPage = routeCalls / operations;
    await nextTurn();
    await nextTurn();
    gc.disconnect();
    loop.disable();
    const sampled = (node) =>
      node.selfSize + node.children.reduce((sum, child) => sum + sampled(child), 0);
    const sampledBytes =
      values.mode === "allocation"
        ? sampled((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : null;
    assert.equal(hash(await run(owner)), wireSha256);
    global.gc();
    await nextTurn();
    const gcSummary = summarizeDurationDistribution(Object.values(gcByKind).flat());
    return {
      side: owner.side,
      pair,
      order,
      ownerSha256: createHash("sha256").update(owner.source).digest("hex"),
      wireSha256,
      operations,
      hostLoad,
      hostLoadAfter: loadavg(),
      elapsedMs,
      routeCallsPerPage: callsPerPage,
      mainCpuMsPerPage: (threadUsed.user + threadUsed.system) / 1000 / operations,
      processCpuMsPerPage: (cpuUsed.user + cpuUsed.system) / 1000 / operations,
      sampledBytesPerPage: sampledBytes === null ? null : sampledBytes / operations,
      latency: summarizeDurationDistribution(times),
      gc: {
        ...gcSummary,
        msPerMinute: (gcSummary.totalMs / elapsedMs) * 60000,
        byKind: Object.fromEntries(
          Object.entries(gcByKind).map(([kind, samples]) => [
            kind,
            summarizeDurationDistribution(samples),
          ]),
        ),
      },
      loop: { count: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
      memory: { before, after, afterGc: process.memoryUsage() },
    };
  } finally {
    gc.disconnect();
    loop.disable();
    if (values.mode === "allocation") {
      inspector.disconnect();
    }
  }
}
try {
  let wireSha256;
  for (const owner of owners) {
    const initial = await run(owner);
    for (const [index, result] of initial.entries()) {
      assert(result.ok);
      assert.equal(result.channel, "forum");
      assert.equal(result.to, requests[index].expected.to);
      assert.equal(result.threadId, requests[index].expected.threadId);
    }
    wireSha256 ??= hash(initial);
    assert.equal(hash(initial), wireSha256);
    for (let index = 0; index < 10; index++) {
      await run(owner);
    }
  }
  const arms = [];
  for (let pair = 0; pair < pairs; pair++) {
    const ordered = pair % 2 === 0 ? owners : owners.toReversed();
    for (const [index, owner] of ordered.entries()) {
      arms.push(await measure(owner, pair + 1, index + 1, wireSha256));
    }
  }
  const report = {
    scope: "200 prepared cron delivery targets; no Gateway, session reads, model turns, or sends",
    mode: values.mode,
    node: process.version,
    pairs,
    operationsPerArm: operations,
    warmupPagesPerOwner: 10,
    jobsPerPage: requests.length,
    agents: agents.length,
    plugins: 40,
    wireSha256,
    arms,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  hook.deregister();
  resetPluginRuntimeStateForTest();
  await rm(root, { recursive: true, force: true });
}
