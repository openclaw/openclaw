/**
 * Run in an isolated Linux PID namespace alongside the existing forest fixture:
 *   cc -O2 -pthread scripts/perf/child-memory-thread-fixture.c -o /tmp/procfs-forest
 *   /tmp/procfs-forest forest 96 24 2 /tmp/procfs-roots.json
 * After FOREST_READY, run five A/A and five A/B pairs serially on the same forest:
 *   node --import ./scripts/tsx.mjs scripts/perf/codex-procfs-snapshot-measure.ts timing
 *   node --import ./scripts/tsx.mjs scripts/perf/codex-procfs-snapshot-measure.ts allocation
 * An optional second argument selects a frozen snapshot module for crossovers.
 * Acceptance: every sample sees >2,000 live rows. Warm wall, main-thread CPU,
 * and allocation must fall beyond A/A spread, with no material p95 or total CPU
 * regression. Cold is the first scan in a fresh JS process, with warm procfs.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

assert.equal(process.platform, "linux");
const [mode = "timing", modulePath] = process.argv.slice(2);
assert(mode === "timing" || mode === "allocation");
const { readCodexAppServerProcessSnapshot } = (await import(
  modulePath
    ? pathToFileURL(resolve(modulePath)).href
    : "../../extensions/codex/src/app-server/transport-process-snapshot.ts"
)) as typeof import("../../extensions/codex/src/app-server/transport-process-snapshot.ts");

async function sample() {
  const cpu = process.cpuUsage();
  const main = process.threadCpuUsage();
  const started = performance.now();
  const rows = await readCodexAppServerProcessSnapshot();
  const wallMs = performance.now() - started;
  const mainCpu = process.threadCpuUsage(main);
  const totalCpu = process.cpuUsage(cpu);
  assert(rows.length > 2_000 && rows.some((row) => row.pid === process.pid));
  return {
    rows: rows.length,
    wallMs,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1_000,
    totalCpuMs: (totalCpu.user + totalCpu.system) / 1_000,
  };
}

const cold = await sample();
for (let warmup = 0; warmup < 5; warmup++) {
  await sample();
}
const samples = 20;
const hostLoad = loadavg();
if (mode === "timing") {
  const warm = [];
  for (let index = 0; index < samples; index++) {
    warm.push(await sample());
  }
  console.log(JSON.stringify({ cold, warm, hostLoad, node: process.version }));
} else {
  const inspector = new Session();
  await startCollectedHeapSampling(inspector, 8192);
  for (let index = 0; index < samples; index++) {
    await sample();
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  console.log(
    JSON.stringify({
      rows: cold.rows,
      sampledHeapBytesPerSnapshot: sumSampledHeapBytes(profile.head) / samples,
      hostLoad,
      node: process.version,
    }),
  );
}
