// Warm writer FIFO owner, real SQLite admission. No model/transport or SQL execution timing.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-write-admission-fs-measure.mjs
//   --root <new-synthetic-directory> --baseline-source <saved-original-owner.ts>
// Five A1/B/A2 batches, separate allocation samples, and one 500 ms filesystem stall per arm.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "baseline-source": { type: "string" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(values.root && values["baseline-source"] && global.gc);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
const source = fs.readFileSync(values["baseline-source"], "utf8");
const baselineUrl = new URL("../../src/state/__lane2113_baseline.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === baselineUrl
      ? { url: baselineUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === baselineUrl
      ? { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true }
      : next(url, context);
  },
});
const baseline = await import(baselineUrl);
hook.deregister();
const candidate = await import("../../src/state/openclaw-agent-write-admission.ts");
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.ts");
const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.ts");
const { retireSqliteDatabaseAdmissionForPath } =
  await import("../../src/infra/sqlite-database-admission.ts");
const location = path.join(root, "proof.sqlite");
const database = openNodeSqliteDatabase(location);
database.exec("CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES(42)");
admitSqliteSchema(database);
const run = async (owner) =>
  owner.runOpenClawAgentPathWriteAdmission(location, async (_identity, current) => {
    await Promise.resolve();
    current();
  });
let active;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const restore = [];
for (const [owner, name] of [
  [fs, "statSync"],
  [fs.realpathSync, "native"],
]) {
  const original = owner[name];
  restore.push(() => {
    owner[name] = original;
  });
  owner[name] = function (...args) {
    if (active) {
      active.count++;
      if (active.inject && !active.injected) {
        active.injected = true;
        Atomics.wait(sleeper, 0, 0, 500);
      }
    }
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();
const rows = [];
try {
  for (const owner of [baseline, candidate]) {
    for (let warm = 0; warm < 50; warm++) {
      await run(owner);
    }
  }
  for (const mode of ["timing", "allocation", "delay"]) {
    for (let sample = 0; sample < 5; sample++) {
      for (const [label, owner] of [
        ["A1", baseline],
        ["B", candidate],
        ["A2", baseline],
      ]) {
        global.gc();
        await delay(2);
        const inspector = new Session();
        if (mode === "allocation") {
          inspector.connect();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const count = mode === "delay" ? 1 : iterations;
        const measured = { count: 0, inject: mode === "delay", injected: false };
        const thread = process.threadCpuUsage();
        const cpu = process.cpuUsage();
        const started = performance.now();
        const heartbeat =
          mode === "delay" ? delay(0).then(() => performance.now() - started) : undefined;
        active = measured;
        for (let operation = 0; operation < count; operation++) {
          await run(owner);
        }
        active = undefined;
        const elapsedMs = performance.now() - started;
        const threadCpu = process.threadCpuUsage(thread);
        const processCpu = process.cpuUsage(cpu);
        let bytes;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const sum = (node) =>
            node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
          bytes = sum(profile.head) / count;
          inspector.disconnect();
        }
        const row = {
          mode,
          sample,
          label,
          operations: count,
          syncCalls: measured.count,
          elapsedMs: elapsedMs / count,
          threadUs: (threadCpu.user + threadCpu.system) / count,
          processUs: (processCpu.user + processCpu.system) / count,
          bytes,
          timerMs: await heartbeat,
          load: loadavg(),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }
  assert.equal(database.prepare("SELECT value FROM proof").get().value, 42);
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(rows, null, 2));
} finally {
  active = undefined;
  for (const reset of restore) {
    reset();
  }
  syncBuiltinESMExports();
  database.close();
  retireSqliteDatabaseAdmissionForPath(location);
}
