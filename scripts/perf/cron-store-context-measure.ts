// Warm cron preparation: only synthetic process state, no Gateway or worker load claim.
// Run: node --import ./scripts/tsx.mjs scripts/perf/cron-store-context-measure.ts
// Use --module <absolute baseline state.ts> for an unchanged owner with resolved imports.
// Repeat with --allocations; sampled runs are not CPU evidence. Default: 5 x 5,000 calls.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GatewayScheduler } from "../../src/infra/gateway-scheduler.js";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "5000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(path.resolve(".local/cron-context-measure-"));
const originalEnv = process.env;
process.env = {
  HOME: root,
  OPENCLAW_STATE_DIR: root,
  ...Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`SYNTHETIC_${index}`, "fixture".repeat(16)]),
  ),
};
const inspector = new Session();
const scheduler = new GatewayScheduler();
const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
try {
  const {
    createCronServiceState,
    prepareCronServiceStore,
  }: typeof import("../../src/cron/service/state.js") = await import(
    values.module ? pathToFileURL(values.module).href : "../../src/cron/service/state.js"
  );
  const state = createCronServiceState({
    scheduler,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    storePath: path.join(root, "explicit-partition.json"),
    cronEnabled: false,
    enqueueSystemEvent() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  await prepareCronServiceStore(state);
  const run = (count: number) => {
    for (let index = 0; index < count; index++) {
      assert.equal(prepareCronServiceStore(state), undefined);
    }
  };
  run(1000);
  inspector.connect();
  for (let sample = 0; sample < 5; sample++) {
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run(iterations);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const bytes = values.allocations
      ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
    console.log(
      JSON.stringify({
        sample,
        iterations,
        environmentKeys: 202,
        load: loadavg(),
        wallMs,
        cpuUsPerCall: (used.user + used.system) / iterations,
        allocatedBytesPerCall: bytes === undefined ? undefined : bytes / iterations,
      }),
    );
  }
} finally {
  inspector.disconnect();
  process.env = originalEnv;
  rmSync(root, { recursive: true, force: true });
}
