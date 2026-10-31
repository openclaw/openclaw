// Measure the pairing snapshot phase used by fresh token issuance, not the whole mutation.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/device-token-snapshot-measure.ts
//   --output <new-directory> --devices 65 --iterations 2000 --pairs 5
// All/one use the real snapshot owner with the former/new selector on identical persisted rows.
// Timing and allocation are separate passes; pair order alternates. No Gateway or live state.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { PairedDevice } from "../../src/infra/device-pairing.types.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    devices: { type: "string", default: "65" },
    iterations: { type: "string", default: "2000" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.output && global.gc, "Supply --output and run with --expose-gc");
const count = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const deviceCount = count(values.devices, "devices");
const iterations = count(values.iterations, "iterations");
const pairs = count(values.pairs, "pairs");
const output = path.resolve(values.output);
mkdirSync(output, { recursive: false });
process.env.OPENCLAW_STATE_DIR = path.join(output, "state");
process.env.OPENCLAW_HOME = output;
const store = await import("../../src/infra/device-pairing-store.ts");
const state = await import("../../src/state/openclaw-state-db.ts");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.ts");
const devices: PairedDevice[] = Array.from({ length: deviceCount }, (_, index) => ({
  deviceId: `synthetic-device-${index}`,
  publicKey: `synthetic-key-${index}`,
  platform: "linux",
  roles: ["node", "operator"],
  scopes: ["operator.read"],
  approvedScopes: ["operator.read"],
  tokens: {
    operator: {
      token: `synthetic-token-${index}`,
      role: "operator",
      scopes: ["operator.read"],
      createdAtMs: 1,
    },
  },
  nodeSurface: {
    caps: ["canvas"],
    commands: ["system.run"],
    bins: ["git", "node"],
    createdAtMs: 1,
    approvedAtMs: 1,
  },
  createdAtMs: 1,
  approvedAtMs: 1,
}));
const database = state.openOpenClawStateDatabase();
const inspector = new Session();
const results: object[] = [];
try {
  store.persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: Object.fromEntries(devices.map((d) => [d.deviceId, d])) },
    process.env.OPENCLAW_STATE_DIR,
    "paired",
  );
  const target = devices[0]!.deviceId;
  const read = (selection: "all" | "one") =>
    store.readPairedDevicePairingSnapshotFromDatabase(
      database.db,
      selection === "one" ? target : undefined,
    );
  const all = read("all");
  const one = read("one");
  assert.deepEqual(one.pairedByDeviceId[target], all.pairedByDeviceId[target]);
  assert.equal(one.revision, all.revision);
  assert.equal(Object.keys(all.pairedByDeviceId).length, deviceCount);
  assert.equal(Object.keys(one.pairedByDeviceId).length, 1);
  inspector.connect();
  for (const mode of ["timing", "allocation"] as const) {
    for (let pair = 0; pair < pairs; pair++) {
      const order = pair % 2 === 0 ? (["all", "one"] as const) : (["one", "all"] as const);
      for (const selection of order) {
        for (let i = 0; i < 100; i++) {
          read(selection);
        }
        global.gc();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        for (let i = 0; i < iterations; i++) {
          read(selection);
        }
        const wallMs = performance.now() - started;
        const used = process.threadCpuUsage(cpu);
        let sampledBytes: number | undefined;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          sampledBytes = sum(profile.head);
        }
        const result = {
          mode,
          pair,
          selection,
          iterations,
          rowsPerOperation: selection === "all" ? deviceCount : 1,
          cpuUsPerOperation: (used.user + used.system) / iterations,
          wallMs,
          sampledBytesPerOperation:
            sampledBytes === undefined ? undefined : sampledBytes / iterations,
          hostLoad: loadavg(),
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  }
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify({ deviceCount, results }, null, 2),
  );
} finally {
  inspector.disconnect();
  await state.closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
