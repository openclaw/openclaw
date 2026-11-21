/**
 * Synthetic session-order owner benchmark (no Gateway or live state).
 * Run against each revision with the same Node and dependency closure:
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/session-list-order-measure.mjs <session-list-order.ts> [iterations=2500] [--team] [--typed-keys] [rows.json]
 * Export actual synthetic Team rows with session-prepared-list-measure.ts --sort-rows.
 * Fixture creation and warmup precede measurement. Timing/GC and allocation are
 * separate passes; allocation sampling includes objects collected by either GC.
 * Compare paired, counterbalanced runs, including descending and unpinned rows.
 * Accept only identical ordering and lower allocation without a descending CPU
 * increase; these are owner measurements, not whole-Gateway latency claims.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2]);
const iterations = Number(process.argv[3] ?? 2500);
const team = process.argv[4] === "--team";
// Inspector sampling excludes TypedArray backing stores; account for candidate keys separately.
const typedKeys = process.argv[5] === "--typed-keys";
const fixturePath = process.argv[6];
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined;
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "run with --expose-gc");
const { sortAndLimitSessionEntries, compareSessionEntryPairs } = await import(
  pathToFileURL(source).href
);
const inspector = new Session();
inspector.connect();
const results = [];
const sampleBytes = (node) =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampleBytes(child), 0);
for (const pinned of [true, false]) {
  const anchor = Date.UTC(2026, 9, 25);
  const rows = fixture
    ? fixture.map(([key, entry]) => [key, pinned ? entry : { ...entry, pinnedAt: undefined }])
    : Array.from({ length: team ? 10800 : 10000 }, (_, index) => [
        `agent:synthetic:${index % 5 === 0 ? "dashboard" : "subagent"}:session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: team ? anchor - ((index * 617) % 10009) * 3_600_000 : (index * 617) % 10009,
          parentSessionKey: "agent:synthetic:main",
          ...(pinned && index % 50 === 0 ? { pinnedAt: (team ? anchor : 100000) + index } : {}),
          ...(team
            ? {
                createdAt: anchor - index * 3_600_000,
                lastActivityAt:
                  index % 3 ? anchor - ((index * 719) % 10009) * 3_600_000 : undefined,
                lastInteractionAt:
                  index % 5 ? anchor - ((index * 317) % 10009) * 3_600_000 : undefined,
              }
            : {}),
        },
      ]);
  for (const sortBy of team ? ["updatedAt", "activity", "lastInteractionAt"] : ["updatedAt"]) {
    const compare = (a, b) => compareSessionEntryPairs(a, b, sortBy);
    const ordered = rows.toSorted(compare);
    for (const [order, input] of [
      ["ascending", ordered],
      ["descending", ordered.toReversed()],
      ["random", rows],
    ]) {
      for (const limit of team ? [200] : [100, undefined]) {
        const expected = limit === undefined ? ordered : ordered.slice(0, limit);
        assert.deepEqual(sortAndLimitSessionEntries(input, limit, sortBy), expected);
        const { sortAndLimitBy } = await import("../../src/shared/sort-and-limit.ts");
        let comparisons = 0;
        sortAndLimitBy(input, limit, (a, b) => {
          comparisons++;
          return compare(a, b);
        });
        for (let i = 0; i < 100; i++) {
          sortAndLimitSessionEntries(input, limit, sortBy);
        }
        globalThis.gc();
        await setImmediate();
        const collections = [];
        const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
        observer.observe({ entryTypes: ["gc"] });
        const hostLoad = loadavg();
        const cpu = process.cpuUsage();
        const start = performance.now();
        let checksum = 0;
        for (let i = 0; i < iterations; i++) {
          checksum += sortAndLimitSessionEntries(input, limit, sortBy).length;
        }
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        await setImmediate();
        await setImmediate();
        collections.push(...observer.takeRecords());
        observer.disconnect();
        assert.equal(checksum, expected.length * iterations);
        const memory = process.memoryUsage();
        globalThis.gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        for (let i = 0; i < iterations; i++) {
          sortAndLimitSessionEntries(input, limit, sortBy);
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        results.push({
          pinned,
          sortBy,
          order,
          entries: input.length,
          comparisons,
          limit: limit ?? null,
          iterations,
          hostLoad,
          cpuMs: (used.user + used.system) / 1000,
          elapsedMs,
          sampledBytes: sampleBytes(profile.head),
          nativeKeyBytes: typedKeys
            ? input.length * (sortBy === "updatedAt" ? 16 : 8) * iterations
            : 0,
          gcMs: collections.reduce((sum, gc) => sum + gc.duration, 0),
          gcCount: collections.length,
          gcMaxMs: Math.max(0, ...collections.map((gc) => gc.duration)),
          gcByKind: Object.groupBy(
            collections.map((gc) => ({ kind: gc.detail.kind, duration: gc.duration })),
            (gc) => gc.kind,
          ),
          rss: memory.rss,
          heapUsed: memory.heapUsed,
        });
      }
    }
  }
}
inspector.disconnect();
console.log(JSON.stringify({ node: process.version, source, results }));
