/**
 * Measure managed sandbox mount preparation on synthetic workspace roots.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sandbox-mount-preparation-measure.ts --owner .
 * Alternate baseline/candidate after A/A controls. Counts are JS calls, not syscalls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "." },
    phase: { type: "string", default: "transport" },
    iterations: { type: "string", default: "30" },
    workspace: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 30,
});
assert(["transport", "computation"].includes(values.phase));
const owner = path.resolve(values.owner);
const load = (file: string) => import(pathToFileURL(path.join(owner, file)).href);
const { prepareSandboxMountPlan } = (await load(
  "src/agents/sandbox/mount-plan.ts",
)) as typeof import("../../src/agents/sandbox/mount-plan.js");
const refresh = (await load(
  "src/skills/runtime/refresh.ts",
)) as typeof import("../../src/skills/runtime/refresh.js");
const physical =
  values.phase === "computation" &&
  fs.existsSync(path.join(owner, "src/agents/sandbox/mount-plan.prepare.ts"))
    ? ((await load(
        "src/agents/sandbox/mount-plan.prepare.ts",
      )) as typeof import("../../src/agents/sandbox/mount-plan.prepare.js"))
    : undefined;
fs.mkdirSync(".local", { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/sandbox-mount-perf-")));
const workspaceDir = values.workspace
  ? fs.realpathSync(values.workspace)
  : path.join(root, "workspace");
const skillsWorkspaceDir = path.join(root, "materialized");
let authorityChecks = 0;
const assertCurrent = () => {
  authorityChecks++;
};
const input = {
  engine: { id: "docker", command: "docker", displayName: "Docker" } as const,
  workspaceDir,
  agentWorkspaceDir: workspaceDir,
  skillsWorkspaceDir,
  workdir: "/workspace",
  workspaceAccess: "rw" as const,
  workspaceSource: "managed-worktree" as const,
  assertCurrent,
};
try {
  for (const directory of [
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, ".agents/skills"),
    path.join(skillsWorkspaceDir, "skills"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  async function run() {
    const plan = physical
      ? await physical.prepareSandboxMountPlanFilesystem(input, assertCurrent)
      : await prepareSandboxMountPlan(input);
    assert.equal(plan.binds.length, 7);
  }
  await refresh.prepareSkillStatusFacts({
    entries: [],
    workspaceDir,
    managedSkillsDir: skillsWorkspaceDir,
  });
  for (let index = 0; index < 5; index++) {
    await run();
  }
  authorityChecks = 0;
  const calls: Record<string, number> = {};
  const restore: Array<() => void> = [];
  for (const name of ["existsSync", "statSync", "lstatSync", "realpathSync"] as const) {
    const original = fs[name];
    const native = fs.realpathSync.native;
    const wrapped = new Proxy(original, {
      apply(fn, self, args) {
        calls[name] = (calls[name] ?? 0) + 1;
        return Reflect.apply(fn, self, args);
      },
    });
    Object.assign(fs, { [name]: wrapped });
    if (name === "realpathSync") {
      fs.realpathSync.native = new Proxy(native, {
        apply(fn, self, args) {
          calls.realpathNative = (calls.realpathNative ?? 0) + 1;
          return Reflect.apply(fn, self, args);
        },
      });
    }
    restore.push(() => {
      Object.assign(fs, { [name]: original });
      fs.realpathSync.native = native;
    });
  }
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const reset of restore.toReversed()) {
      reset();
    }
    syncBuiltinESMExports();
  }
  const checksPerRun = authorityChecks;
  global.gc?.();
  const heap = v8.getHeapStatistics();
  const allocated = "total_allocated_bytes" in heap ? heap.total_allocated_bytes : null;
  const thread = process.threadCpuUsage();
  const total = process.cpuUsage();
  const loadBefore = loadavg();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await run();
  }
  const elapsedMs = performance.now() - start;
  const mainCpu = process.threadCpuUsage(thread);
  const totalCpu = process.cpuUsage(total);
  const heapAfter = v8.getHeapStatistics();
  console.log(
    JSON.stringify({
      owner,
      phase: values.phase,
      node: process.version,
      authorityChecksPerRun: checksPerRun,
      workspace: values.workspace ?? "small-owner-fixture",
      iterations,
      loadBefore,
      mainThreadFsCallsPerRun: calls,
      elapsedMsPerRun: elapsedMs / iterations,
      mainCpuUsPerRun: (mainCpu.user + mainCpu.system) / iterations,
      processCpuUsPerRun: (totalCpu.user + totalCpu.system) / iterations,
      mainAllocatedBytesPerRun:
        allocated === null || !("total_allocated_bytes" in heapAfter)
          ? null
          : (heapAfter.total_allocated_bytes - allocated) / iterations,
      rss: process.memoryUsage().rss,
    }),
  );
} finally {
  await refresh.closeSkillsWatchers?.(true);
  fs.rmSync(root, { recursive: true, force: true });
}
