// Usage: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/gateway-crash-record-measure.mts <source-root> <fixture-state> <A|B-label> <output.json>
// A selects the pre-crash-record owner signature. Run A/A controls, then five A/B pairs serially.
// Admitted worker-kernel work only; heap sampling perturbs timing.
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const [sourceRoot, fixtureRoot, label, output] = process.argv.slice(2);
if (!sourceRoot || !fixtureRoot || !label || !output) {
  throw new Error("root fixture label output required");
}
process.env.OPENCLAW_STATE_DIR = fixtureRoot;
process.env.OPENCLAW_CONFIG_PATH = path.join(fixtureRoot, "openclaw.json");
if (
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, "team-shape-summary.json"), "utf8")).format !==
  "openclaw-team-shape-v1"
) {
  throw new Error("Only an offline synthetic team-shape fixture is accepted");
}
const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } = (await load(
  "src/state/openclaw-state-db.ts",
)) as typeof import("../../src/state/openclaw-state-db.js");
const { gatewayBootOperations } = (await load(
  "src/infra/gateway-boot-lifecycle.worker.ts",
)) as typeof import("../../src/infra/gateway-boot-lifecycle.worker.js");
const { deleteConfigMachineState } = (await load(
  "src/state/config-machine-state-write.ts",
)) as typeof import("../../src/state/config-machine-state-write.js");
const database = openOpenClawStateDatabase({ env: process.env });
const context = {
  open: () => database,
  stateOptions: () => ({ env: process.env, path: database.path }),
};
const isCandidate = label.startsWith("B");
const metadata = {
  version: "synthetic-version",
  commit: "synthetic-commit",
  runtime: process.version,
};
const begin = (nowMs: number) =>
  Reflect.apply(gatewayBootOperations["gatewayBoot.begin"], undefined, [
    isCandidate ? { nowMs, metadata } : nowMs,
    context,
  ]);
const now = Date.now();
function seed() {
  database.db.exec("DELETE FROM gateway_boot_lifecycle");
  deleteConfigMachineState("gateway.crashes", context.stateOptions());
  const add = database.db.prepare(
    "INSERT INTO gateway_boot_lifecycle(boot_id,pid,started_at_ms,completed_at_ms,outcome,startup_reason,reason) VALUES(?,?,?,NULL,NULL,NULL,NULL)",
  );
  database.db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 1000; i++) {
    add.run(`fixture-${i}`, 123, now - 100_000 + i);
  }
  database.db.exec("COMMIT");
}
seed();
for (let i = 0; i < 20; i++) {
  begin(now + i);
}
const statement = database.db.prepare("SELECT 1");
const prototype: StatementSync = Object.getPrototypeOf(statement);
const executed: Record<string, number> = {};
const accessed = new Map<string, number>();
const restore: Array<() => void> = [];
let observing = false;
for (const method of ["run", "get", "all", "iterate"] as const) {
  const original = prototype[method];
  Object.defineProperty(prototype, method, {
    value: new Proxy(original, {
      apply(target, receiver: StatementSync, args) {
        if (observing) {
          executed[receiver.sourceSQL] = (executed[receiver.sourceSQL] ?? 0) + 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
  restore.push(() => Object.defineProperty(prototype, method, { value: original }));
}
for (const method of [
  "readFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "openSync",
] as const) {
  const original = fs[method];
  Object.defineProperty(fs, method, {
    value: new Proxy(original, {
      apply(target, receiver, args) {
        if (observing && typeof args[0] === "string") {
          accessed.set(args[0], (accessed.get(args[0]) ?? 0) + 1);
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
  restore.push(() => Object.defineProperty(fs, method, { value: original }));
}
syncBuiltinESMExports();
const profiler = new Session();
profiler.connect();
const samples = [];
for (let batch = 0; batch < 6; batch++) {
  seed();
  globalThis.gc?.();
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.cpuUsage();
  const started = performance.now();
  observing = true;
  for (let i = 0; i < 100; i++) {
    begin(now + batch * 1000 + i);
  }
  observing = false;
  const elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const heap = await profiler.post("HeapProfiler.stopSampling");
  function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
    return node.selfSize + node.children.reduce((sum, n) => sum + bytes(n), 0);
  }
  samples.push({
    batch,
    operations: 100,
    wallMs: elapsed,
    cpuUserMs: used.user / 1000,
    cpuSystemMs: used.system / 1000,
    sampledAllocatedBytes: bytes(heap.profile.head),
    loadavg: os.loadavg(),
  });
}
profiler.disconnect();
for (const undo of restore) {
  undo();
}
syncBuiltinESMExports();
const historyRow = database.db
  .prepare("SELECT value_json FROM config_machine_state WHERE state_key='gateway.crashes'")
  .get();
await closeOpenClawStateDatabaseAsync();
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      label,
      node: process.version,
      samples,
      executed,
      observedFileAccesses: Object.fromEntries(accessed),
      history: historyRow ? JSON.parse(String(historyRow.value_json)) : null,
    },
    null,
    2,
  ),
);
