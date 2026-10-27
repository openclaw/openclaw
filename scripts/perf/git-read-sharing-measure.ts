/**
 * Git read-cache owner benchmark: 64 viewers, two PR histories per checkout.
 * Usage: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/git-read-sharing-measure.ts [reads=4096] [baseline-source-file|-] [pr|diff]
 * Save the baseline with `git show <base>:src/infra/git-read-cache.ts > <file>`.
 * Run baseline/candidate alternately. The optional source replaces only the cache
 * owner; fixed worker replies exclude worker startup, Git I/O, and GitHub latency.
 * Report worker submissions, untraced thread CPU, and separately sampled allocation.
 * Accept fewer submissions and lower owner CPU/allocation with identical answers;
 * this is not a whole-Gateway or production-frequency measurement.
 * `diff` measures warm polls from 64 viewers interleaving four checkouts, eight
 * sessions, summary/full and all/uncommitted shapes, each with 100 baseline files.
 * Adds 128 unrelated synthetic environment values (128 bytes each); reports only
 * their count. Each request must preserve exact response bytes. For a preparation
 * deletion accept lower CPU/allocation with unchanged revision/diff submissions.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const reads = Number(process.argv[2] ?? 4096);
assert(Number.isSafeInteger(reads) && reads > 0 && reads % 64 === 0);
assert(global.gc, "Run with --expose-gc");
const baseSource =
  process.argv[3] && process.argv[3] !== "-" ? readFileSync(process.argv[3], "utf8") : undefined;
const workload = process.argv[4] ?? "pr";
assert(workload === "pr" || workload === "diff");
if (workload === "diff") {
  for (let index = 0; index < 128; index++) {
    process.env[`BENCH_DIFF_UNRELATED_${index}`] = "x".repeat(128);
  }
}
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
            if (type === "checkout.revision") return { key: "unchanged" };
            if (type === "pull-request.branch-comparison") {
              return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
            }
            if (type === "pull-request.branch-facts") {
              return { creatable: input.mergedHeads[0].sha === "a".repeat(40), stats: null };
            }
            if (type === "checkout.diff") {
              return {
                files: Array.from({ length: 100 }, (_, i) => ({
                  path: "file-" + i + ".txt", status: "modified", additions: 1, deletions: 1,
                  ...(input.summaryOnly ? {} : { patch: "-before\\n+after\\n" }),
                })), additions: 100, deletions: 100,
              };
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
const diffInputs = Array.from({ length: 64 }, (_, index) => {
  const cwd = `/synthetic-checkout-${index % 4}`;
  const sessionId = `session-${index % 8}`;
  return {
    cwd,
    sessionId,
    summaryOnly: Math.floor(index / 8) % 2 === 0,
    scope: Math.floor(index / 16) % 2 === 0 ? ("all" as const) : ("uncommitted" as const),
    baseline: {
      version: 1 as const,
      root: cwd,
      sessionId,
      files: Array.from({ length: 100 }, (_file, file) => ({
        path: `preexisting-${file}.txt`,
        fingerprint: "a".repeat(64),
      })),
    },
  };
});
const expectedDiff = (summary: boolean) =>
  JSON.stringify({
    files: Array.from({ length: 100 }, (_, i) => ({
      path: `file-${i}.txt`,
      status: "modified",
      additions: 1,
      deletions: 1,
      ...(summary ? {} : { patch: "-before\n+after\n" }),
    })),
    additions: 100,
    deletions: 100,
  });
const expectedResponses = diffInputs.map((input) => expectedDiff(input.summaryOnly));
const batch = async () => {
  if (workload === "diff") {
    const results = await Promise.all(
      diffInputs.map((input) =>
        runGitReadOperation({ type: "checkout.diff", input }, { poll: true }),
      ),
    );
    for (let index = 0; index < results.length; index++) {
      assert.equal(JSON.stringify(results[index]), expectedResponses[index]);
    }
    return;
  }
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
// Cold poll handoffs expire after one second; measure the fresh warm path.
if (workload === "diff") {
  await new Promise((resolve) => {
    setTimeout(resolve, 1_001);
  });
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
    workload,
    reads,
    viewers: inputs.length,
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    sampledBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    submissions,
    memory: process.memoryUsage(),
    load: loadavg(),
    ...(workload === "diff"
      ? {
          environmentKeys: Object.keys(process.env).length,
          responseBytesPerBatch: expectedResponses.reduce(
            (sum, response) => sum + Buffer.byteLength(response),
            0,
          ),
          responseSha256: createHash("sha256").update(expectedResponses.join("\n")).digest("hex"),
        }
      : {}),
  }),
);
