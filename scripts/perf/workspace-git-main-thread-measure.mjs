// Synthetic, read-only owner workload. Run through node --import ./scripts/tsx.mjs.
// --source selects a pinned source checkout; use the same fixture for A/A and A/B.
// --mode counts|timing|allocation keeps counters and allocation sampling out of timing.
// Pass --workspace <nested Git workspace> --checkout <linked worktree> --plain <non-Git path>.
// Each sample represents 600 display reads and 30 bootstrap preparations per minute.
// This counts JavaScript sync fs API calls, not kernel syscalls. Git workers retain the
// metadata work; thread CPU/allocations cover the main thread, process CPU includes workers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: process.cwd() },
    workspace: { type: "string" },
    checkout: { type: "string" },
    plain: { type: "string" },
    samples: { type: "string", default: "5" },
    mode: { type: "string", default: "counts" },
  },
});
assert(values.workspace && values.checkout && values.plain);
assert(["counts", "timing", "allocation"].includes(values.mode));
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
const source = path.resolve(values.source);
const load = (name) => import(pathToFileURL(path.join(source, name)).href);
const { hasWorkspaceGitCheckout } = await load("src/agents/workspace-git.ts");
const { resolveRunBootstrapWorkspaceDir } = await load("src/agents/workspace-run.ts");
const { drainGlobalSingletonLifecycleState } = await load("src/shared/global-singleton.ts");
const roots = [path.resolve(values.workspace), path.resolve(values.plain)];
const selectBootstrap = () =>
  resolveRunBootstrapWorkspaceDir({
    workspaceDir: values.checkout,
    bootstrapWorkspaceDir: roots[0],
    sessionRoot: values.checkout,
    requireWorkspaceOnly: true,
  });
let counts = {};
const originals = new Map();
const inspector = values.mode === "allocation" ? new Session() : undefined;
const originalNow = Date.now;
let logicalNow = originalNow();
try {
  if (values.mode === "counts") {
    for (const name of [
      "existsSync",
      "accessSync",
      "statSync",
      "lstatSync",
      "realpathSync",
      "readdirSync",
      "openSync",
      "fstatSync",
      "readSync",
      "readFileSync",
      "closeSync",
    ]) {
      const original = fs[name];
      originals.set(name, original);
      const wrapped = (...args) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return original(...args);
      };
      if (original.native) {
        wrapped.native = (...args) => {
          counts[`${name}.native`] = (counts[`${name}.native`] ?? 0) + 1;
          return original.native(...args);
        };
      }
      fs[name] = wrapped;
    }
    syncBuiltinESMExports();
  }
  inspector?.connect();
  Date.now = () => logicalNow;
  for (let i = 0; i < 5; i++) {
    assert.equal(await hasWorkspaceGitCheckout(roots[0]), true);
    assert.equal(await hasWorkspaceGitCheckout(roots[1]), false);
    assert.equal(await selectBootstrap(), values.checkout);
  }
  for (let sample = 0; sample < samples; sample++) {
    for (const workload of ["display", "bootstrap"]) {
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      counts = {};
      const timing = values.mode === "timing";
      const cpu = timing ? process.cpuUsage() : undefined;
      const thread = timing ? process.threadCpuUsage() : undefined;
      const started = timing ? performance.now() : undefined;
      if (workload === "display") {
        for (let i = 0; i < 600; i++) {
          logicalNow += 100;
          for (const root of roots) {
            await hasWorkspaceGitCheckout(root);
          }
        }
      } else {
        for (let i = 0; i < 30; i++) {
          await selectBootstrap();
        }
      }
      const elapsedMs = timing ? performance.now() - started : undefined;
      const processCpu = timing ? process.cpuUsage(cpu) : undefined;
      const threadCpu = timing ? process.threadCpuUsage(thread) : undefined;
      const profile = inspector
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      console.log(
        JSON.stringify({
          source,
          mode: values.mode,
          sample,
          workload,
          logicalDurationMs: 60_000,
          calls: values.mode === "counts" ? { ...counts } : undefined,
          elapsedMs,
          threadCpuUs: threadCpu && threadCpu.user + threadCpu.system,
          processCpuUs: processCpu && processCpu.user + processCpu.system,
          sampledMainThreadAllocationBytes: profile?.samples.reduce(
            (sum, entry) => sum + entry.size,
            0,
          ),
          load: os.loadavg(),
        }),
      );
    }
  }
} finally {
  Date.now = originalNow;
  inspector?.disconnect();
  for (const [name, original] of originals) {
    fs[name] = original;
  }
  if (originals.size) {
    syncBuiltinESMExports();
  }
  await drainGlobalSingletonLifecycleState();
}
