// Pairing-preparation owner-work model, NOT a NodeRegistry or end-to-end turn benchmark.
// The harness regression proves two refreshes become one; this measures those refreshes
// against a real synthetic 64-node pairing store, retaining the consuming authority check.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/active-node-turn-prepare-measure.ts \
//   --state-dir .local/active-node-fresh --output .local/active-node-result.json
// Default: 2,000 operations/arm, AB/BA in untraced timing and separate sampled-allocation
// passes. Each arm gets equal warmup; GC totals and main-thread CPU exclude forced GC.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    operations: { type: "string", default: "2000" },
  },
});
assert(
  values["state-dir"] && values.output && global.gc,
  "Supply fresh --state-dir, --output, and --expose-gc",
);
assert(
  ![...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((arg) => /--trace[-_]gc/.test(arg)),
  "Run untraced",
);
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0, "--operations must be positive");
const stateDir = path.resolve(values["state-dir"]);
mkdirSync(stateDir, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = stateDir;
const [database, store, pairing, active, lifecycle] = await Promise.all([
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/infra/device-pairing-store.js"),
  import("../../src/infra/device-pairing-node-state.js"),
  import("../../src/infra/active-node-context.js"),
  import("../../src/shared/global-singleton.js"),
]);
const devices: PairedDevice[] = Array.from({ length: 64 }, (_, index) => ({
  deviceId: `synthetic-node-${index}`,
  publicKey: `synthetic-key-${index}`,
  roles: ["node"],
  tokens: { node: { token: `synthetic-token-${index}`, role: "node", scopes: [], createdAtMs: 1 } },
  nodeSurface: {
    caps: ["canvas"],
    commands: ["system.run"],
    createdAtMs: 1,
    approvedAtMs: index + 1,
  },
  createdAtMs: 1,
  approvedAtMs: index + 1,
}));
const inspector = new Session();
const gcEntries: Array<{ at: number; ms: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEntries.push({ at: entry.startTime, ms: entry.duration });
  }
});
const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    maxMs: sorted.at(-1),
  };
};
let reads = 0;
try {
  database.openOpenClawStateDatabase();
  store.persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: Object.fromEntries(devices.map((device) => [device.deviceId, device])),
    },
    stateDir,
    "both",
  );
  const bindings = await Promise.all(
    devices.map((device) => pairing.resolveCurrentPairedDeviceNodeBinding(device.deviceId)),
  );
  active.setActiveNodeContexts(
    devices.map((device, index) => {
      const binding = bindings[index];
      assert(binding, "Synthetic node binding must exist");
      return {
        nodeId: device.deviceId,
        profileId: `synthetic-profile-${index}`,
        prepare: () => {
          reads++;
          return pairing.resolveCurrentPairedDeviceNodeBinding(device.deviceId);
        },
        isCurrent: () => pairing.isPairedDeviceNodeBindingCurrent(device.deviceId, binding),
      };
    }),
  );
  async function run(refreshes: number, count: number, timings?: number[]) {
    for (let index = 0; index < count; index++) {
      const profileId = `synthetic-profile-${index % devices.length}`;
      const started = performance.now();
      for (let refresh = 0; refresh < refreshes; refresh++) {
        await active.prepareActiveNodeContext(profileId);
      }
      assert.equal(
        active.getCurrentActiveNodeContext(profileId)?.nodeId,
        devices[index % devices.length]!.deviceId,
      );
      timings?.push(performance.now() - started);
    }
  }
  inspector.connect();
  observer.observe({ entryTypes: ["gc"] });
  const results = [];
  for (const mode of ["timing", "allocation"] as const) {
    for (const [pair, order] of [
      [2, 1],
      [1, 2],
    ].entries()) {
      for (const refreshes of order) {
        await run(refreshes, 100);
        global.gc();
        await nextTurn();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const before = { load: loadavg(), memory: process.memoryUsage() };
        const cpu = process.threadCpuUsage();
        const latencies: number[] = [];
        const readsBefore = reads;
        const start = performance.now();
        await run(refreshes, operations, mode === "timing" ? latencies : undefined);
        const end = performance.now();
        const usedCpu = process.threadCpuUsage(cpu);
        const after = { load: loadavg(), memory: process.memoryUsage() };
        assert.equal(reads - readsBefore, operations * refreshes);
        let allocation;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const totalBytes = sampledBytes(profile.head);
          allocation = {
            totalBytes,
            bytesPerOperation: totalBytes / operations,
            samplingInterval: 4096,
          };
          writeFileSync(
            `${values.output}.${pair}.${refreshes}.heapprofile`,
            JSON.stringify(profile),
          );
        }
        await nextTurn();
        for (const entry of observer.takeRecords()) {
          gcEntries.push({ at: entry.startTime, ms: entry.duration });
        }
        const collections = gcEntries.filter((entry) => entry.at >= start && entry.at < end);
        const gcMs = collections.reduce((sum, entry) => sum + entry.ms, 0);
        results.push({
          mode,
          pair,
          arm: refreshes === 2 ? "base" : "candidate",
          refreshes,
          operations,
          ownerReads: reads - readsBefore,
          elapsedMs: end - start,
          mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
          latency: mode === "timing" ? distribution(latencies) : undefined,
          allocation,
          gc:
            mode === "timing"
              ? {
                  collections: collections.length,
                  totalMs: gcMs,
                  msPerOperation: gcMs / operations,
                  maxMs: Math.max(0, ...collections.map((entry) => entry.ms)),
                }
              : undefined,
          before,
          after,
        });
      }
    }
  }
  const report = {
    scope:
      "Pairing-preparation owner-work model: 2 refreshes vs 1; no NodeRegistry, Gateway, transport, hooks or model request",
    node: process.version,
    devices: devices.length,
    operations,
    warmupPerArm: 100,
    results,
  };
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  inspector.disconnect();
  observer.disconnect();
  active.setActiveNodeContexts([]);
  await database.closeOpenClawStateDatabaseAsync();
  await lifecycle.drainGlobalSingletonLifecycleState();
}
