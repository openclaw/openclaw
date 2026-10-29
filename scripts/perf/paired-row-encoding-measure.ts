// Compare rejected device-pairing updates against saved baseline source:
// git show <base>:src/infra/device-pairing-store.ts > <baseline.ts>
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/paired-row-encoding-measure.ts
//   --baseline-source <baseline.ts> --output <new-timing-dir>
// Repeat with --allocation --output <new-allocation-dir> for sampled allocation separately.
// Five alternating AB/BA pairs, 5,000 operations per arm (25,000 per side), 65 node records.
// Both owners run against one real bound database; fixture setup stays outside measurement.
// Source hooks preserve relative imports and never modify the checkout's owner module.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { PairedDevice } from "../../src/infra/device-pairing.types.ts";
const { values } = parseArgs({
  options: {
    "baseline-source": { type: "string" },
    output: { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["baseline-source"] && values.output, "--baseline-source and --output required");
assert(global.gc, "--expose-gc required");
const allocation = values.allocation;
const output = path.resolve(values.output);
mkdirSync(output, { recursive: false });
const stateDir = path.join(output, "state");
mkdirSync(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
const owner = new URL("../../src/infra/device-pairing-store.ts", import.meta.url);
const baselineUrl = new URL(`${owner.href}?row-encoding-baseline`);
const baselineSource = readFileSync(path.resolve(values["baseline-source"]), "utf8");
const candidateSource = readFileSync(owner, "utf8");
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const source =
      url === baselineUrl.href ? baselineSource : url === owner.href ? candidateSource : undefined;
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module-typescript", source, shortCircuit: true };
  },
});
const candidate = await import("../../src/infra/device-pairing-store.ts");
const baseline: typeof candidate = await import(baselineUrl.href);
hooks.deregister();
const state = await import("../../src/state/openclaw-state-db.ts");
const { closeOpenClawStateDatabaseByPathAsync } =
  await import("../../src/state/openclaw-state-db-cache.ts");
const { runWithSqliteWorkerStateContext } =
  await import("../../src/infra/sqlite-worker-state-context.ts");
const database = state.openOpenClawStateDatabase({ env });
const devices: Record<string, PairedDevice> = Object.fromEntries(
  Array.from({ length: 65 }, (_, index) => {
    const deviceId = `synthetic-node-${index}`;
    return [
      deviceId,
      {
        deviceId,
        publicKey: `synthetic-key-${index}`,
        displayName: `Synthetic node ${index}`,
        platform: "linux",
        role: "node",
        roles: ["node", "operator"],
        scopes: ["operator.read"],
        approvedScopes: ["operator.read", "operator.write"],
        createdAtMs: 1,
        approvedAtMs: 2,
        tokens: {
          node: {
            token: `synthetic-node-token-${index}`,
            role: "node",
            scopes: [],
            createdAtMs: 2,
          },
          operator: {
            token: `synthetic-operator-token-${index}`,
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 2,
          },
        },
        nodeSurface: {
          createdAtMs: 1,
          approvedAtMs: 2,
          commands: ["system.run", "system.which", "canvas.present"],
          caps: ["canvas", "system"],
          permissions: { screenRecording: true, accessibility: true },
          bins: ["node", "git", "python3", "rg"],
          lastConnectedAtMs: 3,
          lastDisconnectedAtMs: 4,
        },
      },
    ];
  }),
);
candidate.persistDevicePairingStoreState(
  { pendingById: {}, pairedByDeviceId: devices },
  stateDir,
  "paired",
);
const paired = candidate.readPairedDevicePairingSnapshotFromDatabase(database.db).pairedByDeviceId;
const expected = JSON.stringify(paired);
const variants = [
  { name: "base", owner: baseline, source: baselineSource },
  { name: "candidate", owner: candidate, source: candidateSource },
];
const operations = 5_000;
const pairs = 5;
function run(module: typeof candidate, count: number) {
  let rejected = 0;
  runWithSqliteWorkerStateContext({ environment: env }, () =>
    state.runOpenClawStateWriteTransaction(
      () =>
        module.withDevicePairingStoreDatabase(
          database,
          () => {
            for (let i = 0; i < count; i++) {
              const result = module.updatePairedDeviceInTransaction(
                `synthetic-node-${i % 65}`,
                (device) => ({ value: device === null }),
              );
              if (!result) {
                rejected++;
              }
            }
          },
          paired,
        ),
      { database, env },
    ),
  );
  assert.equal(rejected, count);
}
const results = [];
try {
  for (const variant of variants) {
    run(variant.owner, 2000);
  }
  for (let pair = 0; pair < pairs; pair++) {
    const ordered = pair % 2 ? variants.toReversed() : variants;
    for (const [order, variant] of ordered.entries()) {
      global.gc!();
      const profiler = new Session();
      if (allocation) {
        profiler.connect();
        await profiler.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const hostLoadBefore = loadavg();
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      run(variant.owner, operations);
      const elapsedMs = performance.now() - started;
      const usedCpu = process.threadCpuUsage(cpu);
      let sampledBytes: number | undefined;
      if (allocation) {
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
          node.selfSize + node.children.reduce((n, c) => n + sum(c), 0);
        sampledBytes = sum(profile.head);
        profiler.disconnect();
      }
      assert.equal(JSON.stringify(paired), expected);
      const result = {
        arm: variant.name,
        pair: pair + 1,
        order: order + 1,
        mode: allocation ? "allocation" : "untraced",
        operations,
        devices: 65,
        sourceHash: createHash("sha256").update(variant.source).digest("hex"),
        cpuMs: (usedCpu.user + usedCpu.system) / 1000,
        elapsedMs,
        sampledBytes,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  rmSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        results,
        pairs,
        operationsPerArm: operations,
        totalOperationsPerSide: pairs * operations,
        completed: results.length === pairs * 2,
      },
      null,
      2,
    ),
  );
}
