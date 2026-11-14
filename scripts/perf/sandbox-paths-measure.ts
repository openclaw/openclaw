/**
 * Sandbox guard owner benchmark: existing, missing, and aliased roots; the last
 * of 1/4/16 roots admits an absolute candidate. Run prepared owners alternately:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-paths-measure.ts \
 *   --owner src/agents/sandbox-paths.ts --iterations 2000
 * Add --allocations for a separate collected-object allocation sampling pass.
 * --shape alias or missing exercises the retained physical prefix traversal.
 * Reports per-check main-thread CPU, allocation, stat counts, GC, RSS and heap.
 * This measures the owner, not whole-Gateway latency. Setup/warmup/forced GC are
 * outside the measured interval; timed passes do not enable heap sampling.
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
    owner: { type: "string", default: "src/agents/sandbox-paths.ts" },
    iterations: { type: "string", default: "2000" },
    roots: { type: "string", default: "4" },
    shape: { type: "string", default: "existing" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
const rootCount = parseStrictIntegerOption({
  raw: values.roots,
  label: "--roots",
  min: 1,
  fallback: 4,
});
assert(["existing", "alias", "missing"].includes(values.shape));
assert(global.gc, "Run with --expose-gc");
const ownerPath = path.resolve(values.owner);
const owner = (await import(
  pathToFileURL(ownerPath).href
)) as typeof import("../../src/agents/sandbox-paths.js");
fs.mkdirSync(".local", { recursive: true });
const fixture = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/sandbox-paths-measure-")));
try {
  const roots = Array.from({ length: rootCount }, (_, index) =>
    path.join(fixture, `root-${index}`),
  );
  for (const root of roots) {
    if (values.shape === "alias") {
      fs.mkdirSync(`${root}-physical`);
      fs.symlinkSync(`${root}-physical`, root, "dir");
    } else if (values.shape === "existing") {
      fs.mkdirSync(root);
    }
  }
  const target = path.join(roots[rootCount - 1]!, "new.txt");
  async function check() {
    for (const root of roots) {
      try {
        return await owner.assertSandboxPath({ filePath: target, cwd: root, root });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Path escapes sandbox root (")) {
          throw error;
        }
      }
    }
    throw new Error("No root admitted the fixture");
  }
  assert.equal((await check()).resolved, target);
  for (let index = 0; index < 100; index++) {
    await check();
  }
  const originalLstat = fs.lstatSync;
  const originalStat = fs.statSync;
  let lstats = 0;
  let stats = 0;
  fs.lstatSync = new Proxy(originalLstat, {
    apply(method, receiver, args) {
      lstats++;
      return Reflect.apply(method, receiver, args);
    },
  });
  fs.statSync = new Proxy(originalStat, {
    apply(method, receiver, args) {
      stats++;
      return Reflect.apply(method, receiver, args);
    },
  });
  try {
    await check();
  } finally {
    fs.lstatSync = originalLstat;
    fs.statSync = originalStat;
  }
  await nextTurn();
  global.gc();
  await nextTurn();
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  let gcMs = 0;
  let gcCount = 0;
  let started = Number.POSITIVE_INFINITY;
  let ended = Number.POSITIVE_INFINITY;
  const gcByKind: Record<number, { count: number; durationMs: number; maxMs: number }> = {};
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.startTime < started || entry.startTime >= ended) {
        continue;
      }
      gcMs += entry.duration;
      gcCount++;
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
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await check();
  }
  ended = performance.now();
  const elapsedMs = ended - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  if (values.allocations) {
    const profile = (await inspector.post("HeapProfiler.stopSampling")).profile;
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  console.log(
    JSON.stringify({
      host: hostname(),
      node: process.version,
      loadBefore,
      loadAfter: loadavg(),
      ownerSha256: createHash("sha256").update(fs.readFileSync(ownerPath)).digest("hex"),
      rootCount,
      shape: values.shape,
      iterations,
      allocationSampling: values.allocations,
      lstatsPerCheck: lstats,
      statsPerCheck: stats,
      elapsedMs,
      cpuUsPerCheck: values.allocations ? undefined : (cpu.user + cpu.system) / iterations,
      allocatedBytesPerCheck:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      gcMs,
      gcCount,
      gcByKind,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    }),
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
