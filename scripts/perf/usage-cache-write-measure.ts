/**
 * Usage-cache writer owner microbenchmark (not Gateway/SQLite throughput).
 * Run: node --expose-gc scripts/perf/usage-cache-write-measure.ts BASE_ROOT CANDIDATE_ROOT
 *   [ITERATIONS=3000] [PAIRS=5]
 * Extracts createCacheWriteSource/createCacheWriter verbatim from each revision.
 * A controlled in-memory admission wait holds writes, then a fake worker checks
 * every submitted byte. Real admission/persistence are covered by owner tests.
 * Cycles 40 session rollups with UTF-8 metadata and four daily partitions each.
 * Inputs are allocated before measurement and kept live, like host request data.
 * Counterbalanced unprofiled CPU passes are separate from allocation/survivor
 * sampling. Survivors follow three forced full GCs with writes still pending;
 * this measures retained copies, not production promotion rate. No tracing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GCProfiler } from "node:v8";

const [base, candidate, countArg = "3000", pairsArg = "5"] = process.argv.slice(2);
assert(base && candidate && global.gc, "Use --expose-gc and BASE_ROOT CANDIDATE_ROOT");
const iterations = Number(countArg);
const pairs = Number(pairsArg);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const encoder = new TextEncoder();
const rows = Array.from({ length: 40 }, (_, index) => ({
  rollupId: `agent:synthetic:session-${index}`,
  valueJson: encoder.encode(JSON.stringify({ totalTokens: 32000, totalCost: 0.25, index })),
  blob: new Uint8Array(256).fill(index),
  updatedAt: index + 1,
  partitions: Array.from({ length: 4 }, (_partition, day) => ({
    date: `2026-10-${String(day + 1).padStart(2, "0")}`,
    valueJson: JSON.stringify({ totalTokens: 8000, totalCost: 0.0625 }),
    blob: new Uint8Array(128).fill(index + day),
  })),
  removedDates: ["2026-09-30"],
  replacePartitions: false,
}));
const inputs = Array.from({ length: iterations }, (_, index) => [rows[index % rows.length]!]);
const expected = inputs.map((input) => JSON.stringify(input));
type Owner = {
  write: (type: string, input: (typeof inputs)[number]) => Promise<boolean>;
  close: () => Promise<void>;
};
type Loaded = { writer: Owner; release: () => void; received: unknown[]; sha256: string };
async function load(root: string, label: string): Promise<Loaded> {
  const source = readFileSync(
    path.join(root, "src/infra/session-cost-usage-cache.sqlite.ts"),
    "utf8",
  );
  const start = source.indexOf("function createCacheWriteSource(");
  const end = source.indexOf("export async function retireLegacySessionCostUsageCache(");
  assert(start >= 0 && end > start, "Writer extraction boundary changed");
  const code = stripTypeScriptTypes(`
${source.slice(start, end)}
export const received = [];
let resolve;
const gate = new Promise(done => { resolve = done; });
export const release = () => resolve();
async function runOpenClawAgentWorkerWrite(_options, run) { await gate; return run(); }
const captureOpenClawAgentDatabasePreparationExecution = () => ({
  prepare: async () => {},
  runExisting: async (source, run) => {
    source.assertCurrent();
    return run({ execute: async (command) => { received.push(command.input); return true; } });
  },
  release: async () => {},
});
export const writer = createCacheWriter({}, {
  key: "file:synthetic", birthtime: 1, canonicalPath: "/synthetic/usage.sqlite",
});
`);
  return {
    ...(await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${label}`
    )),
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}
async function collect() {
  for (let pass = 0; pass < 3; pass++) {
    await nextTurn();
    global.gc!();
  }
}
for (const mode of ["timing", "allocation", "survivors"] as const) {
  for (let pair = 0; pair < pairs; pair++) {
    for (const side of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
      const loaded = await load(side === "base" ? base : candidate, `${mode}-${pair}-${side}`);
      await collect();
      const before = process.memoryUsage();
      const inspector = new Session();
      if (mode !== "timing") {
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: mode === "allocation",
          includeObjectsCollectedByMinorGC: mode === "allocation",
        });
      }
      const profiler = new GCProfiler();
      profiler.start();
      const loadBefore = loadavg();
      const cpuBefore = process.threadCpuUsage();
      const started = performance.now();
      const pending = inputs.map((input) => loaded.writer.write("usageCache.writeRollup", input));
      const elapsedMs = performance.now() - started;
      const cpu = process.threadCpuUsage(cpuBefore);
      const gc = profiler.stop()?.statistics ?? [];
      if (mode === "survivors") {
        await collect();
      }
      const memory = process.memoryUsage();
      let sampledBytes: number | undefined;
      let samples: number | undefined;
      if (mode !== "timing") {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
        samples = profile.samples.length;
        inspector.disconnect();
      }
      assert.equal(loaded.received.length, 0, "Writes must remain behind admission during capture");
      loaded.release();
      assert((await Promise.all(pending)).every((written) => written));
      assert.equal(loaded.received.length, iterations);
      for (let index = 0; index < iterations; index++) {
        assert.equal(JSON.stringify(loaded.received[index]), expected[index]);
      }
      loaded.received.length = 0;
      await loaded.writer.close();
      console.log(
        JSON.stringify({
          mode,
          pair,
          side,
          iterations,
          sessions: rows.length,
          sourceSha256: loaded.sha256,
          elapsedMs,
          mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
          sampledBytes,
          samples,
          heapDeltaBytes: memory.heapUsed - before.heapUsed,
          arrayBufferDeltaBytes: memory.arrayBuffers - before.arrayBuffers,
          rssBytes: memory.rss,
          heapBytes: memory.heapUsed,
          loadBefore,
          loadAfter: loadavg(),
          gc: gc.map(({ gcType, cost }) => ({ kind: gcType, ms: cost / 1000 })),
          byteIdentical: true,
        }),
      );
    }
  }
}
