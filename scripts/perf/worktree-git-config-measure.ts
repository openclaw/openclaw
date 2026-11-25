/**
 * Safe-config setup plus a real packed blob read and ref transaction.
 * First generate the large repo with git-operation-allocation-fixture.py. This
 * script changes only that synthetic repo's eight layout settings and one ref.
 * Usage: node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/worktree-git-config-measure.ts <fixture-dir> [iterations=200] [baseline-source|-] [allocations]
 * Save the old checkout-git-config.ts with git show before editing. The optional
 * source replaces only that owner, keeping its original relative imports.
 * Alternate baseline/candidate launches; use untraced CPU/latency and a separate
 * allocations pass. CPU is owner main-thread CPU, excluding child Git CPU. Counts are Git executor invocations (no retries in this local
 * fixture). Accept fewer config writes and lower CPU/allocation with exact blob
 * bytes and ref OIDs preserved. Tails below 1,000 samples are descriptive only.
 * This measures the owner, not whole-Gateway latency or production frequency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";

const fixture = path.resolve(process.argv[2]!);
const iterations = Number(process.argv[3] ?? 200);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const baseline =
  process.argv[4] && process.argv[4] !== "-" ? readFileSync(process.argv[4], "utf8") : undefined;
const allocations = process.argv[5] === "allocations";
const counts: Record<string, number> = {};
const measurement = globalThis as typeof globalThis & { countGit?: (command: string) => void };
measurement.countGit = (command) => {
  counts[command] = (counts[command] ?? 0) + 1;
};
registerHooks({
  load(url, context, nextLoad) {
    if (baseline && url.endsWith("/src/agents/worktrees/checkout-git-config.ts")) {
      return { format: "module-typescript", shortCircuit: true, source: baseline };
    }
    if (url.endsWith("/src/infra/git-exec.ts")) {
      const source = readFileSync(new URL(url), "utf8");
      const marker =
        /const \{ (runCommandWithTimeout|runCommandBuffersWithTimeout|runCommandBuffered) \} = await import/g;
      assert.equal([...source.matchAll(marker)].length, 3);
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: source.replace(marker, "globalThis.countGit(args[0]); $&"),
      };
    }
    return nextLoad(url, context);
  },
});
const { withWorktreeGitConfig } = await import("../../src/agents/worktrees/checkout-git-config.js");
const { requireGit } = await import("../../src/agents/worktrees/git.js");
const repo = path.join(fixture, "repo");
const roots = Array.from({ length: 64 }, (_, i) =>
  path.join(fixture, `worktrees/wt-${String(i).padStart(3, "0")}`),
);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
for (const [key, value] of Object.entries({
  symlinks: "true",
  ignorecase: "false",
  precomposeunicode: "true",
  excludesfile: path.join(fixture, "absent-ignore"),
  autocrlf: "false",
  eol: "lf",
  sparsecheckout: "false",
  sparsecheckoutcone: "false",
})) {
  git("config", `core.${key}`, value);
}
const head = git("rev-parse", "HEAD");
const base = git("rev-parse", "HEAD~10");
const blob = git("rev-parse", "HEAD:tracked/file-0000.txt");
const expected = execFileSync("git", ["-C", repo, "cat-file", "blob", blob]);
const ref = "refs/openclaw/measure-config";
const run = async (index: number) => {
  const root = roots[index % roots.length]!;
  await withWorktreeGitConfig(root, true, {}, async (policy) => {
    const result = await policy.worker.buffered(root, ["cat-file", "blob", blob]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, expected);
    await policy.require(root, ["update-ref", "--stdin"], {
      input: `update ${ref} ${index % 2 === 0 ? head : base}\n`,
    });
  });
};
for (let i = 0; i < 5; i++) {
  await run(i);
}
for (const key of Object.keys(counts)) {
  delete counts[key];
}
global.gc?.();
const inspector = allocations ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const samples: number[] = [];
const cpu = process.threadCpuUsage();
const startingLoad = loadavg();
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  const begin = performance.now();
  await run(i + 5);
  samples.push(performance.now() - begin);
}
const elapsedMs = performance.now() - started;
const used = process.threadCpuUsage(cpu);
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
const measuredCounts = { ...counts };
assert.equal(await requireGit(repo, ["rev-parse", ref]), (iterations + 4) % 2 === 0 ? head : base);
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    arm: baseline ? "base" : "candidate",
    iterations,
    allocations,
    cpuMs: (used.user + used.system) / 1000,
    elapsedMs,
    p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
    p99Ms: samples[Math.ceil(samples.length * 0.99) - 1],
    sampledBytes,
    counts: measuredCounts,
    memory: process.memoryUsage(),
    startingLoad,
    load: loadavg(),
  }),
);
