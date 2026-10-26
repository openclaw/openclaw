/**
 * Git read-cache owner benchmark: 64 viewers, two PR histories per checkout.
 * Usage: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/git-read-sharing-measure.ts [reads=4096] [baseline-source-file]
 * Save the baseline with `git show <base>:src/infra/git-read-cache.ts > <file>`.
 * Run baseline/candidate alternately. The optional source replaces only the cache
 * owner; fixed worker replies exclude worker startup, Git I/O, and GitHub latency.
 * Report worker submissions, untraced thread CPU, and separately sampled allocation.
 * Accept fewer submissions and lower owner CPU/allocation with identical answers;
 * this is not a whole-Gateway or production-frequency measurement.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const reads = Number(process.argv[2] ?? 4096);
assert(Number.isSafeInteger(reads) && reads > 0 && reads % 64 === 0);
assert(global.gc, "Run with --expose-gc");
const baseSource = process.argv[3] ? readFileSync(process.argv[3], "utf8") : undefined;
const owner = fileURLToPath(new URL("../../src/infra/git-read-cache.ts", import.meta.url));
const worker = fileURLToPath(new URL("../../src/infra/git-worker.ts", import.meta.url));
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && fileURLToPath(url) === worker) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const counts = {};
          export async function runGitWorkerOperation({ type, input }) {
            counts[type] = (counts[type] ?? 0) + 1;
            if (type === "checkout.revision") return "unchanged";
            if (type === "pull-request.branch-comparison") {
              return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
            }
            if (type === "pull-request.branch-facts") {
              return { creatable: input.mergedHeads[0].sha === "a".repeat(40), stats: null };
            }
            throw new Error("Unexpected worker operation");
          }
        `,
      };
    }
    if (baseSource && url.startsWith("file:") && fileURLToPath(url) === owner) {
      return { format: "module-typescript", shortCircuit: true, source: baseSource };
    }
    return nextLoad(url, context);
  },
});
const { runGitReadOperation } = await import("../../src/infra/git-read-cache.js");
// The fixture exports counters only in this benchmark's isolated module graph.
const fixture: { counts: Record<string, number> } = await import(worker);
hook.deregister();
const inputs = Array.from({ length: 64 }, (_, index) => ({
  root: `/synthetic-checkout-${Math.floor(index / 2)}`,
  branch: "feature",
  defaultBranch: "main",
  mergedHeads: [{ sha: (index % 2 === 0 ? "a" : "b").repeat(40), baseRef: "main" }],
}));
const batch = async () => {
  const results = await Promise.all(
    inputs.map((input) => runGitReadOperation({ type: "pull-request.branch-facts", input })),
  );
  for (let index = 0; index < results.length; index++) {
    assert.deepEqual(results[index], { creatable: index % 2 === 0, stats: null });
  }
};
for (let warmup = 0; warmup < 8; warmup++) {
  await batch();
}
const run = async () => {
  for (let index = 0; index < reads; index += inputs.length) {
    await batch();
  }
};
for (const key of Object.keys(fixture.counts)) {
  fixture.counts[key] = 0;
}
global.gc();
const cpu = process.threadCpuUsage();
const started = performance.now();
await run();
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
const submissions = { ...fixture.counts };
global.gc();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 4096,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
await run();
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
console.log(
  JSON.stringify({
    arm: baseSource ? "base" : "candidate",
    reads,
    viewers: inputs.length,
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    sampledBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    submissions,
    memory: process.memoryUsage(),
    load: loadavg(),
  }),
);
