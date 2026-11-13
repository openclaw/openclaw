/**
 * Guarded ClawHub tracking publication through install, untrack and rollback.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/clawhub-write-main-thread-measure.ts
 * --owner selects a prepared baseline owner; alternate baseline/candidate processes.
 * --delay-ms injects equal latency into sync and async content writes.
 * --allocations samples allocations separately from untraced CPU/timing passes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/skills/lifecycle/clawhub-store.ts" },
    iterations: { type: "string", default: "100" },
    warmups: { type: "string", default: "50" },
    "delay-ms": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
const delayMs = Number(values["delay-ms"]);
const iterations = Number(values.iterations);
const warmups = Number(values.warmups);
assert(Number.isSafeInteger(delayMs) && delayMs >= 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(warmups) && warmups >= 0);
assert(global.gc, "Run with --expose-gc");
let active = false;
let synchronousWrites = 0;
let asynchronousWrites = 0;
const timers: Promise<void>[] = [];
const delays: number[] = [];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const originalWrite = fs.writeFileSync;
const originalAsyncWrite = fsp.writeFile;
function observeDelay() {
  const start = performance.now();
  timers.push(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        delays.push(performance.now() - start);
        resolve();
      }, 0);
    }),
  );
}
fs.writeFileSync = new Proxy(originalWrite, {
  apply(method, receiver, args) {
    if (active) {
      synchronousWrites++;
      if (delayMs) {
        observeDelay();
        Atomics.wait(sleeper, 0, 0, delayMs);
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
fsp.writeFile = async (...args: Parameters<typeof fsp.writeFile>) => {
  if (active) {
    asynchronousWrites++;
    if (delayMs) {
      observeDelay();
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  return await originalAsyncWrite(...args);
};
await fsp.mkdir(".local", { recursive: true });
const fixture = await fsp.mkdtemp(path.resolve(".local/clawhub-write-measure-"));
const skillDir = path.join(fixture, "skills", "canary");
try {
  await fsp.mkdir(skillDir, { recursive: true });
  const owner = (await import(
    pathToFileURL(path.resolve(values.owner)).href
  )) as typeof import("../../src/skills/lifecycle/clawhub-store.js");
  const beforePersistentApply = () => {};
  const run = async () => {
    await owner.recordClawHubSkillInstall({
      workspaceDir: fixture,
      skillDir,
      origin: {
        version: 1,
        registry: "https://clawhub.ai",
        slug: "canary",
        installedVersion: "1.0.0",
        installedAt: 1,
      },
      beforePersistentApply,
    });
    const restore = await owner.untrackClawHubSkill(fixture, "canary", beforePersistentApply);
    await restore();
  };
  for (let index = 0; index < warmups; index++) {
    await run();
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const load = loadavg();
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const start = performance.now();
  active = true;
  for (let index = 0; index < iterations; index++) {
    await run();
  }
  active = false;
  const elapsedMs = performance.now() - start;
  const totalCpu = process.cpuUsage(cpu);
  const mainCpu = process.threadCpuUsage(thread);
  await Promise.all(timers);
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocationBytes = sum(profile.head);
    inspector.disconnect();
  }
  const lock = JSON.parse(await fsp.readFile(path.join(fixture, ".clawhub", "lock.json"), "utf8"));
  assert.equal(lock.skills.canary.version, "1.0.0");
  console.log(
    JSON.stringify({
      owner: values.owner,
      iterations,
      warmups,
      publications: iterations * 4,
      delayMs,
      elapsedMs,
      mainCpuUs: mainCpu.user + mainCpu.system,
      totalCpuUs: totalCpu.user + totalCpu.system,
      synchronousWrites,
      asynchronousWrites,
      allocationBytes,
      maxTimerDelayMs: Math.max(0, ...delays),
      load,
    }),
  );
} finally {
  active = false;
  fs.writeFileSync = originalWrite;
  fsp.writeFile = originalAsyncWrite;
  await fsp.rm(fixture, { recursive: true, force: true });
}
