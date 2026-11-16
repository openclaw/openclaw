// Run with Node 26+ and the checkout's scripts/tsx.mjs preload. Arguments:
// <checkout> <sample-label> <synthetic-fixture-directory>. Prepare the existing
// focused Vitest worker artifacts first; their original absolute output paths
// must resolve. No compiler, import setup, or fixture creation is timed.
// Measures one cold real start-to-refused-spawn operation, including worker
// startup and settlement. No helper or service is launched. Serial A/A and A/B
// samples compare main-thread metadata calls and heartbeat; elapsed time, main
// and process CPU, and V8 allocation expose the relocation cost independently.
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
const [checkout, label, fixture] = process.argv.slice(2);
assert(path.isAbsolute(checkout) && path.isAbsolute(fixture));
const sample = fs.mkdtempSync(path.join(fixture, "handoff-2535-"));
const root = path.join(sample, "install");
const tmp = path.join(sample, "tmp");
for (const directory of [root, tmp, path.join(sample, "state"), path.join(sample, "home")]) {
  fs.mkdirSync(directory, { mode: 0o700 });
}
process.env.HOME = path.join(sample, "home");
process.env.TMPDIR = tmp;
process.env.OPENCLAW_STATE_DIR = path.join(sample, "state");
const env = {
  HOME: process.env.HOME,
  TMPDIR: tmp,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  PATH: process.env.PATH,
};
const { installDatabaseEngineSelection } = await import(
  pathToFileURL(path.join(checkout, "src/infra/database-engine/context.ts"))
);
const { resolveDatabaseFamilyEngines } = await import(
  pathToFileURL(path.join(checkout, "src/infra/database-engine/registry.ts"))
);
installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
const dist = path.join(checkout, ".artifacts/vitest-worker-cache/run-cache-0/outputs/dist");
const { startManagedServiceUpdateHandoff } = await import(
  pathToFileURL(path.join(dist, "infra/update-managed-service-handoff.js"))
);
const refusedSpawn = new Error("synthetic spawn boundary");
let spawnAttempts = 0;
const originals = new Map();
const syncMetadata = {};
for (const name of [
  "openSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "writeFileSync",
  "copyFileSync",
  "existsSync",
]) {
  const original = fs[name];
  originals.set(name, original);
  fs[name] = function (...args) {
    if (args.some((argument) => typeof argument === "string" && argument.startsWith(sample))) {
      syncMetadata[name] = (syncMetadata[name] ?? 0) + 1;
    }
    return Reflect.apply(original, this, args);
  };
}
const originalSpawn = cp.spawn;
cp.spawn = () => {
  spawnAttempts++;
  throw refusedSpawn;
};
syncBuiltinESMExports();
const gaps = [];
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  gaps.push(now - previous);
  previous = now;
}, 1);
try {
  await sleep(20);
  gaps.length = 0;
  previous = performance.now();
  const threadCpu = process.threadCpuUsage();
  const totalCpu = process.cpuUsage();
  const allocated = getHeapStatistics().total_allocated_bytes;
  const start = performance.now();
  await assert.rejects(
    startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: process.execPath,
      argv1: path.join(root, "openclaw.mjs"),
      env,
      meta: {},
    }),
    /synthetic spawn boundary/,
  );
  const elapsedMs = performance.now() - start;
  const allocationBytes = getHeapStatistics().total_allocated_bytes - allocated;
  const mainCpu = process.threadCpuUsage(threadCpu);
  const allCpu = process.cpuUsage(totalCpu);
  await sleep(5);
  assert.equal(spawnAttempts, 1);
  const coordinator = path.join(
    tmp,
    `openclaw-${process.getuid()}`,
    "managed-update-handoffs.sqlite",
  );
  assert(fs.statSync(coordinator).isFile());
  console.log(
    JSON.stringify({
      label,
      elapsedMs,
      mainCpuUs: mainCpu.user + mainCpu.system,
      processCpuUs: allCpu.user + allCpu.system,
      allocationBytes,
      heartbeatMaxMs: Math.max(...gaps),
      heartbeatCount: gaps.length,
      spawnAttempts,
      syncMetadata,
      coordinatorBytes: fs.statSync(coordinator).size,
      load: os.loadavg(),
      node: process.version,
    }),
  );
} finally {
  clearInterval(heartbeat);
  cp.spawn = originalSpawn;
  for (const [name, original] of originals) {
    fs[name] = original;
  }
  syncBuiltinESMExports();
  fs.rmSync(sample, { recursive: true, force: true });
}
