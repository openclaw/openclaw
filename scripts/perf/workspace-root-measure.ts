/**
 * Linked-workspace Git discovery (owner-only; no Gateway or production state):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-root-measure.ts \
 *   --owner src/agents/workspace-write-scope.ts --iterations 2000
 * Run base/candidate alternately. Add --allocations for separate heap sampling,
 * or --delay-ms 2000 for one delayed .git read; both arms must incur that delay.
 * Counts cover Git content reads; fs-safe prefix traversal remains synchronous.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/workspace-write-scope.ts" },
    iterations: { type: "string", default: "2000" },
    "delay-ms": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
const delayMs = parseStrictIntegerOption({
  raw: values["delay-ms"],
  label: "--delay-ms",
  min: 0,
  fallback: 0,
});
const iterations = delayMs
  ? 1
  : parseStrictIntegerOption({
      raw: values.iterations,
      label: "--iterations",
      min: 1,
      fallback: 2000,
    });
assert(global.gc, "Run with --expose-gc");
const ownerPath = path.resolve(values.owner);
fs.mkdirSync(".local", { recursive: true });
const fixture = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/workspace-root-measure-")));
const root = path.join(fixture, "workspace");
const commonDir = path.join(fixture, "repository", ".git");
const gitDir = path.join(commonDir, "worktrees", "workspace");
const gitFile = path.join(root, ".git");
const originalSync = fs.readFileSync;
const originalAsync = asyncFs.readFile;
let armed = false;
let syncReads = 0;
let asyncReads = 0;
let delayedReads = 0;
const timerLatenessMs: number[] = [];
const timerWaits: Promise<void>[] = [];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function observeRead(input: unknown, synchronous: boolean): boolean {
  if (!armed || typeof input !== "string" || !input.startsWith(fixture + path.sep)) {
    return false;
  }
  if (synchronous) {
    syncReads++;
  } else {
    asyncReads++;
  }
  if (!delayMs || input !== gitFile) {
    return false;
  }
  delayedReads++;
  const started = performance.now();
  timerWaits.push(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timerLatenessMs.push(performance.now() - started);
        resolve();
      }, 0);
    }),
  );
  return true;
}
fs.readFileSync = new Proxy(originalSync, {
  apply(method, receiver, args) {
    if (observeRead(args[0], true)) {
      Atomics.wait(sleeper, 0, 0, delayMs);
    }
    return Reflect.apply(method, receiver, args);
  },
});
asyncFs.readFile = new Proxy(originalAsync, {
  async apply(method, receiver, args) {
    if (observeRead(args[0], false)) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    return Reflect.apply(method, receiver, args);
  },
});
try {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(gitFile, `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitDir, "gitdir"), `${gitFile}\n`);
  const target = path.join(root, "nested", "source.txt");
  const owner = (await import(pathToFileURL(ownerPath).href)) as {
    resolveHostWorkspaceRoot: (root: string, target: string) => string;
    resolveHostRootAsync?: (root: string, target: string) => Promise<string>;
  };
  const resolveRoot = owner.resolveHostRootAsync ?? owner.resolveHostWorkspaceRoot;
  for (let i = 0; i < 100; i++) {
    assert.equal(await resolveRoot(root, target), root);
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
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const totalBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const started = performance.now();
  armed = true;
  for (let i = 0; i < iterations; i++) {
    assert.equal(await resolveRoot(root, target), root);
  }
  armed = false;
  const elapsedMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(threadBefore);
  const totalCpu = process.cpuUsage(totalBefore);
  let allocatedBytesPerOperation: number | undefined;
  if (values.allocations) {
    const profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytesPerOperation = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  await Promise.all(timerWaits);
  console.log(
    JSON.stringify({
      ownerSha256: createHash("sha256").update(originalSync(ownerPath)).digest("hex"),
      iterations,
      delayMs,
      delayedReads,
      syncReads,
      asyncReads,
      elapsedMs,
      mainCpuUsPerOperation: (mainCpu.user + mainCpu.system) / iterations,
      totalCpuUsPerOperation: (totalCpu.user + totalCpu.system) / iterations,
      allocatedBytesPerOperation,
      timerLatenessMs,
      hostLoad,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    }),
  );
} finally {
  fs.readFileSync = originalSync;
  asyncFs.readFile = originalAsync;
  fs.rmSync(fixture, { recursive: true, force: true });
}
