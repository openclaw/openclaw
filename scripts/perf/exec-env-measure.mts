/**
 * Run: pnpm exec tsx scripts/perf/exec-env-measure.mts <baseline exec-spawn module>
 * Materialize baseline beside its imports with git show; remove it after measurement.
 * Synthetic 180-key environment, 10,000 Git command preparations, five AA/AB pairs.
 * CPU and sampled allocation captures are separate. Require equal environment
 * contents, unchanged inputs, and lower median CPU/allocation with no p95 regression.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommandEnv as after } from "../../src/process/exec-spawn.js";
assert(process.argv[2], "Supply a baseline exec-spawn module");
const { resolveCommandEnv: before }: { resolveCommandEnv: typeof after } = await import(
  pathToFileURL(path.resolve(process.argv[2])).href
);
const input = {
  argv: ["git", "status", "--short"],
  baseEnv: Object.fromEntries(
    Array.from({ length: 180 }, (_, i) => [`SYNTHETIC_${i}`, "value".repeat(10)]),
  ),
  env: { PATH: "/usr/bin", OPENCLAW_CLI: "0" },
};
assert.deepEqual({ ...before(input) }, { ...after(input) });
const session = new Session();
session.connect();
for (const phase of ["timing", "allocation"]) {
  for (const mode of ["warmup", ...Array.from({ length: 5 }, () => ["A", "A2", "A", "B"]).flat()]) {
    const run = mode === "B" ? after : before;
    for (let i = 0; i < 100; i++) {
      run(input);
    }
    if (phase === "allocation") {
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const result = run(input);
      if (result.OPENCLAW_CLI !== "1") {
        throw new Error("marker");
      }
    }
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const allocatedBytes =
      phase === "allocation"
        ? (await session.post("HeapProfiler.stopSampling")).profile.samples.reduce(
            (a, s) => a + s.size,
            0,
          )
        : undefined;
    console.log(
      JSON.stringify({
        phase,
        mode,
        iterations: 10000,
        elapsedMs,
        mainCpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
      }),
    );
  }
}
assert.equal(input.env.OPENCLAW_CLI, "0");
session.disconnect();
