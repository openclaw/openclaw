/**
 * Completed tasks must collect while their scheduled request contexts remain live.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/execution-capacity-retention.ts
 *   --output <result.json> --operations 1000 [--expect-released]
 * Baseline: --baseline-dir <directory containing exact baseline source files>.
 * Run --profile and --allocations separately from uninstrumented timing samples.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { queryObjects } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    operations: { type: "string", default: "200" },
    allocations: { type: "boolean" },
    profile: { type: "boolean" },
    "expect-released": { type: "boolean" },
  },
});
assert(values.output && global.gc, "Pass --output and run with --expose-gc");
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const root = fileURLToPath(new URL("../../", import.meta.url));
if (values["baseline-dir"]) {
  const baseline = path.resolve(values["baseline-dir"]);
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".ts")) {
        return nextLoad(url, context);
      }
      const file = path.join(baseline, path.relative(root, fileURLToPath(url)));
      if (!existsSync(file)) {
        return nextLoad(url, context);
      }
      return {
        format: "module",
        source: transformSync(readFileSync(file, "utf8"), {
          loader: "ts",
          format: "esm",
          target: "esnext",
        }).code,
        shortCircuit: true,
      };
    },
  });
}
const [
  capacity,
  { SessionManager },
  { Agent },
  { ModelRegistry },
  { AuthStorage },
  resources,
  { createTestGatewayScheduler },
  { collectForRetentionCheck },
] = await Promise.all([
  import("../../src/agents/embedded-agent-runner/run/execution-capacity.ts"),
  import("../../src/agents/sessions/session-manager.ts"),
  import("../../src/plugin-sdk/agent-core.ts"),
  import("../../src/agents/sessions/model-registry.ts"),
  import("../../src/agents/sessions/auth-storage.ts"),
  import("../../src/context-engine/registry.resources.ts"),
  import("../../src/test-utils/gateway-scheduler-clock.ts"),
  import("../../src/test-utils/retention.ts"),
]);
let scheduler = createTestGatewayScheduler();
const maintenance = () => {};
const enqueue: Parameters<typeof capacity.withReleasableExecutionCapacity>[0] = (task) => task();
async function operation(index: number) {
  const state = {
    manager: SessionManager.inMemory(),
    agent: new Agent(),
    registry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    source: new resources.ContextEngineFactoryResources([]),
  };
  await state.manager.appendMessageAsync({
    role: "user",
    content: "Synthetic retained history. ".repeat(8192),
    timestamp: 1,
  });
  try {
    await capacity.withReleasableExecutionCapacity(enqueue, async () => {
      scheduler.schedule({ id: `completed-capacity-${index}`, delayMs: 60000, run: maintenance });
      const read = () => state.manager.getSessionId();
      if (index % 3 !== 0) {
        await capacity.outsideExecutionCapacity(async () => read());
      }
      assert.equal(state.agent.state.messages.length, 0);
      assert.equal(state.registry.getAll().length, 0);
      await resources.disposeContextEngineSources(undefined, [state.source]);
      if (index % 3 === 2) {
        throw new Error("Synthetic completed task failure");
      }
      return read();
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Synthetic completed task failure") {
      throw error;
    }
  }
}
const constructors = {
  managers: SessionManager,
  agents: Agent,
  registries: ModelRegistry,
  factoryResources: resources.ContextEngineFactoryResources,
};
async function capture() {
  await collectForRetentionCheck("capacity-owner");
  const counts = Object.fromEntries(
    Object.entries(constructors).map(([key, constructor]) => [
      key,
      queryObjects(constructor, { format: "count" }),
    ]),
  );
  global.gc!();
  return { counts, heapUsed: process.memoryUsage().heapUsed };
}
for (let index = 0; index < 12; index++) {
  await operation(index);
}
await scheduler.stop();
scheduler = createTestGatewayScheduler();
const before = await capture();
const profiler = new Session();
profiler.connect();
if (values.profile) {
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.start");
}
if (values.allocations) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
const timings: number[] = [];
for (let index = 0; index < operations; index++) {
  const began = performance.now();
  await operation(index);
  timings.push(performance.now() - began);
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
let allocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocationBytes = sum(profile.head);
}
if (values.profile) {
  const { profile } = await profiler.post("Profiler.stop");
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
}
profiler.disconnect();
const after = await capture();
timings.sort((a, b) => a - b);
const result = {
  node: process.version,
  operations,
  before,
  after,
  elapsedMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  allocationBytes,
  medianMs: timings[Math.floor(timings.length / 2)],
  p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
  hostLoad,
  hostLoadEnd: loadavg(),
};
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await scheduler.stop();
if (values["expect-released"]) {
  assert.deepEqual(after.counts, before.counts);
}
