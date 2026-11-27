// Benchmark-only worker observation, based on skill-resource-admission-measure.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import workerThreads from "node:worker_threads";
export async function observeBootstrapWorkers(mode, fixtureRoot) {
  const original = workerThreads.Worker;
  const workers = new Set();
  const filesystemWorkers = new Set();
  const counters = mode === "counts" ? new BigInt64Array(new SharedArrayBuffer(17 * 8)) : undefined;
  const preload = new URL("./bootstrap-read-count-preload.mjs", import.meta.url).href;
  if (counters) {
    const calibrationPath = path.join(fixtureRoot, "sync-counter-calibration");
    fs.writeFileSync(calibrationPath, "synthetic counter calibration\n");
    workerThreads.setEnvironmentData("lane2424.bootstrap-read-calibration", calibrationPath);
    workerThreads.setEnvironmentData("lane2424.bootstrap-read-metrics", counters.buffer);
    await import(preload);
  }
  workerThreads.Worker = class extends original {
    constructor(filename, options) {
      super(
        filename,
        counters
          ? {
              ...options,
              execArgv: [...(options?.execArgv ?? process.execArgv), "--import", preload],
            }
          : options,
      );
      workers.add(this);
      if (/[/\\]fs-safe-copy\.worker\.(?:js|mjs|ts)(?:[?#].*)?$/.test(String(filename))) {
        filesystemWorkers.add(this);
      }
      this.once("exit", () => {
        workers.delete(this);
        filesystemWorkers.delete(this);
      });
    }
  };
  syncBuiltinESMExports();
  // Idle workers are unref'd; their statistics promises do not retain the loop.
  const lifetime = setInterval(() => {}, 1000);
  const readCounts = () =>
    counters
      ? {
          main: {
            calls: Number(Atomics.load(counters, 1)),
            bytes: Number(Atomics.load(counters, 2)),
            eof: Number(Atomics.load(counters, 3)),
            errors: Number(Atomics.load(counters, 4)),
            pending: Number(Atomics.load(counters, 9)),
            syncCalls: Number(Atomics.load(counters, 11)),
          },
          calibration: {
            main: Number(Atomics.load(counters, 13)),
            workers: Number(Atomics.load(counters, 14)),
          },
          workers: {
            calls: Number(Atomics.load(counters, 5)),
            bytes: Number(Atomics.load(counters, 6)),
            eof: Number(Atomics.load(counters, 7)),
            errors: Number(Atomics.load(counters, 8)),
            pending: Number(Atomics.load(counters, 10)),
            syncCalls: Number(Atomics.load(counters, 12)),
          },
        }
      : undefined;
  const assertPopulation = (expected) => {
    assert(Number.isSafeInteger(expected) && expected >= 0, "Expected worker count is required");
    assert.equal(
      filesystemWorkers.size,
      expected,
      "Expected fs-safe-copy pool workers were not observed",
    );
    assert.equal(
      workers.size,
      expected,
      "Unexpected unrelated tracked worker in owner measurement",
    );
    if (counters) {
      assert.equal(
        Number(Atomics.load(counters, 13)),
        1,
        "Main named-export/native counter calibration failed",
      );
      assert.equal(
        Number(Atomics.load(counters, 14)),
        expected,
        "Worker named-export/native counter calibration failed",
      );
    }
    return { expected, filesystem: filesystemWorkers.size, allTracked: workers.size };
  };
  const memory = async (expected) => {
    const population = assertPopulation(expected);
    const membership = [...workers];
    const main = getHeapStatistics();
    const heaps = await Promise.all(membership.map((worker) => worker.getHeapStatistics()));
    assert(
      membership.length === workers.size && membership.every((worker) => workers.has(worker)),
      "Worker membership changed during heap observation",
    );
    assert(
      Number.isFinite(main.total_allocated_bytes) &&
        heaps.every((heap) => Number.isFinite(heap.total_allocated_bytes)),
      "Node runtime lacks exact cumulative heap allocation counter; heap size is not allocation",
    );
    assertPopulation(expected);
    return {
      population,
      membership,
      mainUsedHeapBytes: main.used_heap_size,
      mainTotalHeapBytes: main.total_heap_size,
      workerUsedHeapBytes: heaps.map((heap) => heap.used_heap_size),
      workerTotalHeapBytes: heaps.map((heap) => heap.total_heap_size),
      mainAllocated: main.total_allocated_bytes,
      workerAllocated: heaps.reduce((sum, heap) => sum + heap.total_allocated_bytes, 0),
      mainExternal: main.external_memory,
      workerExternal: heaps.map((heap) => heap.external_memory),
    };
  };
  return {
    beginCounts() {
      if (counters) {
        Atomics.store(counters, 0, 0n);
        counters.fill(0n, 1, 13);
        Atomics.store(counters, 0, 1n);
      }
    },
    endCounts() {
      if (counters) {
        Atomics.store(counters, 0, 0n);
        const value = readCounts();
        assert.equal(
          value.main.pending + value.workers.pending,
          0,
          "Descriptor callbacks remain pending",
        );
        return value;
      }
      return undefined;
    },
    memory,
    assertPopulation,
    allocationDelta(before, after) {
      assert(
        before.membership.length === after.membership.length &&
          before.membership.every((worker) => after.membership.includes(worker)),
        "Allocation interval lost or added a worker",
      );
      assert(
        after.mainAllocated >= before.mainAllocated &&
          after.workerAllocated >= before.workerAllocated,
        "Cumulative heap allocation counter decreased",
      );
      return {
        population: after.population,
        mainUsedHeapBytesBefore: before.mainUsedHeapBytes,
        mainUsedHeapBytesAfter: after.mainUsedHeapBytes,
        mainTotalHeapBytesBefore: before.mainTotalHeapBytes,
        mainTotalHeapBytesAfter: after.mainTotalHeapBytes,
        workerUsedHeapBytesBefore: before.workerUsedHeapBytes,
        workerUsedHeapBytesAfter: after.workerUsedHeapBytes,
        workerTotalHeapBytesBefore: before.workerTotalHeapBytes,
        workerTotalHeapBytesAfter: after.workerTotalHeapBytes,
        heapSnapshotScope:
          "Post-warmup used/total heap snapshots; no worker GC, NOT retained-after-GC memory or allocation.",
        mainHeapAllocatedBytes: after.mainAllocated - before.mainAllocated,
        workerHeapAllocatedBytes: after.workerAllocated - before.workerAllocated,
        totalHeapAllocatedBytes:
          after.mainAllocated +
          after.workerAllocated -
          before.mainAllocated -
          before.workerAllocated,
        mainExternalBefore: before.mainExternal,
        mainExternalAfter: after.mainExternal,
        workerExternalBefore: before.workerExternal,
        workerExternalAfter: after.workerExternal,
        workerCount: after.membership.length,
        scope:
          "Exact Node26 cumulative V8 heap allocation across main and retained workers. External Buffer backing-store allocation is NOT included; external values are endpoint heap statistics, not allocation.",
      };
    },
    async close() {
      clearInterval(lifetime);
      workerThreads.Worker = original;
      syncBuiltinESMExports();
      if (counters) {
        workerThreads.setEnvironmentData("lane2424.bootstrap-read-metrics", undefined);
        workerThreads.setEnvironmentData("lane2424.bootstrap-read-calibration", undefined);
      }
    },
  };
}
