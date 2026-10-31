/**
 * Prompt-project owner only; no Gateway/model/DB activity.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prompt-repository-measure.ts
 *   --root <synthetic-workspace> [--owner <baseline-prompt-projects.ts>]
 * Five interleaved A/B/A batches; --delay-ms 100 injects latency per marker stat.
 * Use --allocations separately. A turn calls preparation for its hook and runtime.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    owner: { type: "string", default: "src/agents/prompt-projects.ts" },
    iterations: { type: "string", default: "200" },
    "delay-ms": { type: "string", default: "0" },
    allocations: { type: "boolean" },
  },
});
assert(values.root, "--root must name a synthetic repository fixture");
assert(global.gc, "use --expose-gc");
const root = path.resolve(values.root);
const integer = (name: "iterations" | "delay-ms", fallback: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 0, fallback });
const delayMs = integer("delay-ms", 0);
const iterations = delayMs ? 5 : integer("iterations", 200);
assert(iterations > 0);
const owner = (await import(pathToFileURL(path.resolve(values.owner)).href)) as {
  prepareAgentPromptProjects: (params: {
    workspaceDir: string;
    cwd: string;
    sessionId: string;
  }) => Promise<{ repoRoot: string | null }>;
  withAgentPromptProjects?: <T>(run: () => T) => T;
};
const turn = async () => {
  const run = async () => {
    const params = { workspaceDir: root, cwd: root, sessionId: "synthetic-perf-turn" };
    assert.equal((await owner.prepareAgentPromptProjects(params)).repoRoot, root);
    assert.equal((await owner.prepareAgentPromptProjects(params)).repoRoot, root);
  };
  await (owner.withAgentPromptProjects ? owner.withAgentPromptProjects(run) : run());
};
for (let i = 0; i < 20; i++) {
  await turn();
}
const marker = path.join(root, ".git");
const originalSync = fs.statSync;
const originalAsync = asyncFs.stat;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let syncStats = 0;
let asyncStats = 0;
fs.statSync = new Proxy(originalSync, {
  apply(method, receiver, args) {
    if (String(args[0]) === marker) {
      syncStats++;
      if (delayMs) {
        Atomics.wait(sleeper, 0, 0, delayMs);
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
asyncFs.stat = new Proxy(originalAsync, {
  apply(method, receiver, args) {
    if (String(args[0]) === marker) {
      asyncStats++;
      if (delayMs) {
        return delay(delayMs).then(() => Reflect.apply(method, receiver, args));
      }
    }
    return Reflect.apply(method, receiver, args);
  },
});
const inspector = new Session();
try {
  global.gc();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const totalStart = process.cpuUsage();
  const mainStart = process.threadCpuUsage();
  const times: number[] = [];
  const timerDelays: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const timer = delayMs
      ? delay(0).then(() => timerDelays.push(performance.now() - start))
      : undefined;
    await turn();
    times.push(performance.now() - start);
    await timer;
  }
  const mainCpu = process.threadCpuUsage(mainStart);
  const totalCpu = process.cpuUsage(totalStart);
  let allocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
    allocationBytes = sum(profile.head) / iterations;
  }
  const percentile = (numbers: number[], fraction: number) =>
    numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1];
  console.log(
    JSON.stringify({
      owner: values.owner,
      root,
      iterations,
      delayMs,
      hostLoad,
      node: process.version,
      syncStatsPerTurn: syncStats / iterations,
      asyncStatsPerTurn: asyncStats / iterations,
      meanMs: times.reduce((n, ms) => n + ms, 0) / iterations,
      medianMs: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      mainCpuUs: (mainCpu.user + mainCpu.system) / iterations,
      totalCpuUs: (totalCpu.user + totalCpu.system) / iterations,
      allocationBytes,
      timerMedianMs: timerDelays.length ? percentile(timerDelays, 0.5) : undefined,
      timerP95Ms: timerDelays.length ? percentile(timerDelays, 0.95) : undefined,
    }),
  );
} finally {
  fs.statSync = originalSync;
  asyncFs.stat = originalAsync;
  inspector.disconnect();
}
