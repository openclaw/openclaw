// Run with node --import ./scripts/tsx.mjs scripts/perf/session-list-order-measure.ts.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { runSynchronousWork } from "../../src/shared/synchronous-work.js";

const inspector = new Session();
inspector.connect();
const countWork = process.argv.includes("--count-work");
if (countWork) {
  // Enable before loading the owner so optimized code cannot omit call counters.
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
}
const { sortAndLimitSessionEntries } = await import("../../src/gateway/session-list-order.js");
const { readSessionListSelectionFacts } = await import("../../src/gateway/session-list-target.js");

const fixtures = Array.from({ length: 5_000 }, (_, i) => {
  const key = `agent:main:${i % 7 === 0 ? "subagent:" : "session-"}${i}`;
  return [
    key,
    {
      sessionId: `session-${i}`,
      updatedAt: (Math.imul(i + 1, 2654435761) >>> 0) % 900,
      createdAt: i,
      ...(i % 3 ? { lastInteractionAt: i % 500 } : {}),
      ...(i % 5 ? { lastActivityAt: i % 700 } : {}),
      ...(i % 31 === 0 ? { pinnedAt: i % 100 } : {}),
      ...(i % 11 === 0 ? { spawnedBy: "agent:main:parent" } : {}),
    },
  ] as const;
});
const prepare = () =>
  fixtures.map(([key, entry]) => [key, entry, readSessionListSelectionFacts(key, entry)] as const);
const rows = prepare();
const modes = ["updatedAt", "lastInteractionAt", "activity"] as const;
const limit = 200;
const consume = (mode: (typeof modes)[number]) =>
  runSynchronousWork(sortAndLimitSessionEntries(rows, limit, mode));
const golden = Object.fromEntries(modes.map((mode) => [mode, consume(mode).map(([key]) => key)]));
type AllocationNode = { selfSize: number; children: AllocationNode[] };
const bytes = (node: AllocationNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
async function measure(run: () => void, operations: number) {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    await inspector.post("HeapProfiler.collectGarbage");
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const before = process.threadCpuUsage();
    run();
    const cpu = process.threadCpuUsage(before);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    samples.push({
      cpuMsPerOperation: (cpu.user + cpu.system) / 1000 / operations,
      allocationBytesPerOperation: bytes(profile.head) / operations,
    });
  }
  return samples;
}
try {
  if (countWork) {
    await inspector.post("Profiler.takePreciseCoverage");
    for (const mode of modes) {
      const result = consume(mode);
      assert.equal(result.length, limit);
      assert.deepEqual(
        result.map(([key]) => key),
        golden[mode],
      );
    }
    const { result } = await inspector.post("Profiler.takePreciseCoverage");
    const countedNames = new Set([
      "compareSessionEntryPairs",
      "compareSessionEntries",
      "sessionActivityTimestamp",
      "isPinnableSessionEntry",
      "normalizeSessionKeyPreservingOpaquePeerIds",
    ]);
    const work = result.flatMap((script) =>
      script.functions
        .filter((fn) => countedNames.has(fn.functionName))
        .map((fn) => ({ name: fn.functionName, calls: fn.ranges[0]!.count })),
    );
    await inspector.post("Profiler.stopPreciseCoverage");
    console.log(JSON.stringify({ rows: rows.length, limit, modes, work, golden }));
  } else {
    const preparation = await measure(() => {
      for (let i = 0; i < 10; i++) {
        assert.equal(prepare().length, rows.length);
      }
    }, 10 * rows.length);
    for (let i = 0; i < 100; i++) {
      for (const mode of modes) {
        consume(mode);
      }
    }
    const sorting = await measure(() => {
      for (let i = 0; i < 100; i++) {
        for (const mode of modes) {
          consume(mode);
        }
      }
    }, 300);
    console.log(JSON.stringify({ rows: rows.length, limit, modes, preparation, sorting, golden }));
  }
} finally {
  inspector.disconnect();
}
