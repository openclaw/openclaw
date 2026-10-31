/**
 * Admitted patch descriptor reads over a prepared 256 KiB workspace file:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/patch-file-read-measure.ts \
 *   --owner src/agents/apply-patch-file-ops.ts --iterations 2000
 * Add --allocations for a separate collected-object allocation sampling pass.
 * --delay-ms 2000 runs one measured read with injected descriptor-read latency;
 * its timer starts at the read seam, after admission, and reports loop lateness.
 * Run prepared base/candidate owners alternately; this is owner-only evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { hostname, loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/agents/apply-patch-file-ops.ts" },
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
const originalReadSync = fs.readFileSync;
const originalRead = fs.readFile;
let armed = false;
let syncReads = 0;
let asyncReads = 0;
const timerWaits: Promise<void>[] = [];
const timerLatenessMs: number[] = [];
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function observeRead() {
  const start = performance.now();
  timerWaits.push(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timerLatenessMs.push(performance.now() - start);
        resolve();
      }, 0);
    }),
  );
}
fs.readFileSync = new Proxy(originalReadSync, {
  apply(method, receiver, args) {
    if (armed && typeof args[0] === "number") {
      syncReads++;
      if (delayMs) {
        observeRead();
        Atomics.wait(sleepBuffer, 0, 0, delayMs);
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
fs.readFile = new Proxy(originalRead, {
  apply(method, receiver, args) {
    if (armed && typeof args[0] === "number") {
      asyncReads++;
      if (delayMs) {
        observeRead();
        setTimeout(() => Reflect.apply(method, receiver, args), delayMs);
        return undefined;
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
fs.mkdirSync(".local", { recursive: true });
const fixture = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/patch-file-read-measure-")));
try {
  fs.mkdirSync(path.join(fixture, ".git"));
  const target = path.join(fixture, "workspace-source.txt");
  const contents = "export const fixture = 'workspace patch read';\n"
    .repeat(6000)
    .slice(0, 256 * 1024);
  fs.writeFileSync(target, contents);
  const owner = (await import(
    pathToFileURL(ownerPath).href
  )) as typeof import("../../src/agents/apply-patch-file-ops.js");
  const ops = await owner.resolvePatchFileOps({ cwd: fixture, workspaceOnly: true });
  assert.equal(await ops.readFile(target), contents);
  for (let index = 0; index < 100; index++) {
    await ops.readFile(target);
  }
  await nextTurn();
  global.gc();
  await nextTurn();
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  let started = Number.POSITIVE_INFINITY;
  let ended = Number.POSITIVE_INFINITY;
  const gcByKind: Record<number, { count: number; durationMs: number; maxMs: number }> = {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < started || entry.startTime >= ended) {
        continue;
      }
      const detail: unknown = Reflect.get(entry, "detail");
      assert(
        detail && typeof detail === "object" && "kind" in detail && typeof detail.kind === "number",
      );
      const kind = (gcByKind[detail.kind] ??= { count: 0, durationMs: 0, maxMs: 0 });
      kind.count++;
      kind.durationMs += entry.duration;
      kind.maxMs = Math.max(kind.maxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const totalBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  armed = true;
  started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await ops.readFile(target);
  }
  ended = performance.now();
  armed = false;
  const threadCpu = process.threadCpuUsage(threadBefore);
  const totalCpu = process.cpuUsage(totalBefore);
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    const profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  await Promise.all(timerWaits);
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  const gc = Object.values(gcByKind);
  console.log(
    JSON.stringify({
      host: hostname(),
      node: process.version,
      loadBefore,
      loadAfter: loadavg(),
      ownerSha256: createHash("sha256").update(originalReadSync(ownerPath)).digest("hex"),
      bytesPerRead: Buffer.byteLength(contents),
      iterations,
      allocationSampling: values.allocations,
      delayMs,
      elapsedMs: ended - started,
      mainThreadCpuUsPerRead: (threadCpu.user + threadCpu.system) / iterations,
      totalCpuUsPerRead: (totalCpu.user + totalCpu.system) / iterations,
      allocatedBytesPerRead: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      syncReads,
      asyncReads,
      timerLatenessMs,
      gcMs: gc.reduce((total, kind) => total + kind.durationMs, 0),
      gcCount: gc.reduce((total, kind) => total + kind.count, 0),
      gcMaxMs: Math.max(0, ...gc.map((kind) => kind.maxMs)),
      gcByKind,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    }),
  );
} finally {
  armed = false;
  fs.readFileSync = originalReadSync;
  fs.readFile = originalRead;
  fs.rmSync(fixture, { recursive: true, force: true });
}
