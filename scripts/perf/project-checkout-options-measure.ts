/**
 * Real-Git checkout discovery, 40 synthetic repositories with 64 branches each.
 * node --import ./scripts/tsx.mjs scripts/perf/project-checkout-options-measure.ts
 *   <base-project-checkout.ts> <candidate-project-checkout.ts> [iterations=200]
 * Freeze base beside project-checkout.ts to preserve relative import resolution.
 * Five counterbalanced timing pairs, then five separate 4 KiB allocation pairs.
 * Acceptance: identical caller-visible roots, fewer Git commands, lower main-thread
 * CPU/allocation. p99 is context below 1,000 samples per arm. No network, credentials,
 * Gateway load, session registry, or external state; fixtures live under .local.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const [base, candidate, count = "200"] = process.argv.slice(2);
assert(base && candidate);
const iterations = Number(count);
assert(Number.isSafeInteger(iterations) && iterations > 0);
type Checkout = typeof import("../../src/projects/project-checkout.js");
const owners: Record<string, Checkout> = {
  base: await import(pathToFileURL(path.resolve(base)).href),
  candidate: await import(pathToFileURL(path.resolve(candidate)).href),
};
const exec = promisify(execFile);
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/checkout-options-"));
const inspector = new Session();
const traceBefore = process.env.GIT_TRACE2_EVENT;
const trace = path.join(root, "git-trace.jsonl");
const repos: string[] = [];
const run = async (arm: string, size: number, latency?: number[]) => {
  for (let index = 0; index < size; index++) {
    const repo = repos[index % repos.length]!;
    const started = performance.now();
    const result = await owners[arm]!.resolveProjectCheckout(repo);
    assert.equal(result.path, repo);
    assert.equal(result.repoRoot, repo);
    latency?.push(performance.now() - started);
  }
};
try {
  for (let index = 0; index < 40; index++) {
    const repo = path.join(root, `repo-${index}`);
    await exec("git", ["init", "--quiet", "-b", "main", repo]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    await exec("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      `https://github.com/synthetic/repo-${index}.git`,
    ]);
    const refs = path.join(repo, ".git/refs/heads");
    const head = await fs.readFile(path.join(refs, "main"));
    for (let branch = 0; branch < 64; branch++) {
      await fs.writeFile(path.join(refs, `branch-${branch}`), head);
    }
    repos.push(await fs.realpath(repo));
  }
  const commands: Record<string, number> = {};
  for (const arm of ["base", "candidate"]) {
    await fs.writeFile(trace, "");
    process.env.GIT_TRACE2_EVENT = trace;
    await run(arm, repos.length);
    commands[arm] =
      (await fs.readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === "start").length / repos.length;
  }
  if (traceBefore === undefined) {
    delete process.env.GIT_TRACE2_EVENT;
  } else {
    process.env.GIT_TRACE2_EVENT = traceBefore;
  }
  inspector.connect();
  for (const allocations of [false, true]) {
    for (let pair = 0; pair < 5; pair++) {
      for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        if (allocations) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const latency: number[] = [];
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        await run(arm, iterations, latency);
        const elapsedMs = performance.now() - started;
        const used = process.threadCpuUsage(cpu);
        const sampledBytes = allocations
          ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
              (sum, sample) => sum + sample.size,
              0,
            )
          : undefined;
        latency.sort((a, b) => a - b);
        console.log(
          JSON.stringify({
            arm,
            pair,
            allocations,
            iterations,
            repositories: repos.length,
            branchesPerRepository: 64,
            commandsPerCall: commands[arm],
            hostLoad,
            elapsedMs,
            cpuUsPerCall: (used.user + used.system) / iterations,
            sampledBytesPerCall: sampledBytes === undefined ? undefined : sampledBytes / iterations,
            p50Ms: latency[Math.ceil(iterations * 0.5) - 1],
            p99Ms: latency[Math.ceil(iterations * 0.99) - 1],
            memory: process.memoryUsage(),
          }),
        );
      }
    }
  }
} finally {
  inspector.disconnect();
  if (traceBefore === undefined) {
    delete process.env.GIT_TRACE2_EVENT;
  } else {
    process.env.GIT_TRACE2_EVENT = traceBefore;
  }
  await fs.rm(root, { recursive: true, force: true });
}
