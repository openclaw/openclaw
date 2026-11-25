/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-inspection-measure.ts
 *   --root /scratch/inspection --seed
 * Alternate --base-file .local/lane2391/inspection-base.ts and current source; --estimate includes sizes.
 * --profile is an output prefix. One sample/process, natural warm caches; import/seed/verification excluded.
 * Two A/A controls then five AB pairs: identical paths/bytes, lower median/p95 wall time and Git spawns,
 * no >20% CPU/allocation regression. Sampled allocation includes collected objects; Linux includes child CPU.
 * Native Git/fs owner only, no Gateway. Other OSes report process CPU. Synthetic 65,880 × 33,333 bytes.
 */
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import inspector from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import * as fixture from "./worktree-provisioning-dependency-fixture.js";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    label: { type: "string", default: "candidate" },
    "base-file": { type: "string" },
    seed: { type: "boolean", default: false },
    estimate: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});
assert(values.root, "--root is required");
const source = path.join(path.resolve(values.root), "source");
const files = fixture.dependencyFixturePaths().toSorted();
const fileBytes = 33_333;
if (values.seed) {
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(source);
  await fixture.seedDependencyFixture(source, fileBytes);
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "add", ".gitignore", ".worktreeinclude"]);
  console.log(JSON.stringify({ source, files: files.length, bytes: files.length * fileBytes }));
} else {
  const ownerUrl = new URL(
    "../../src/agents/worktrees/git-worktree-operations.runtime.ts",
    import.meta.url,
  ).href;
  const baseUrl = values["base-file"]
    ? pathToFileURL(path.resolve(values["base-file"])).href
    : undefined;
  const hooks = registerHooks({
    load(url, context, next) {
      return next(url === ownerUrl && baseUrl ? baseUrl : url, context);
    },
  });
  const profiler = new inspector.Session();
  const spawn = childProcess.spawn;
  let spawnCount = 0;
  try {
    const { executeGitWorktreeOperation } =
      await import("../../src/agents/worktrees/git-worktree-operations.runtime.js");
    const ticks =
      process.platform === "linux"
        ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
        : undefined;
    const childCpuMs = () => {
      if (ticks === undefined) {
        return undefined;
      }
      const fields = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
      return ((Number(fields[13]) + Number(fields[14])) * 1000) / ticks;
    };
    const exact = Number.isFinite(getHeapStatistics().total_allocated_bytes);
    profiler.connect();
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 65536,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    if (values.profile) {
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
    }
    Object.defineProperty(childProcess, "spawn", {
      value: (...args: Parameters<typeof spawn>) => {
        spawnCount++;
        return spawn(...args);
      },
    });
    syncBuiltinESMExports();
    const memoryBefore = process.memoryUsage();
    const loadBefore = loadavg();
    const childBefore = childCpuMs();
    const allocationBefore = getHeapStatistics().total_allocated_bytes;
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    const result = await executeGitWorktreeOperation({
      type: "worktree.provisioning-inspection",
      input: { sourceRoot: source, estimateBytes: values.estimate },
    });
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    const childMs = childBefore === undefined ? undefined : childCpuMs()! - childBefore;
    const exactBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
    const memoryAfter = process.memoryUsage();
    const loadAfter = loadavg();
    const { profile: heap } = await profiler.post("HeapProfiler.stopSampling");
    const allocated = (node: typeof heap.head): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    if (values.profile) {
      const { profile: cpuProfile } = await profiler.post("Profiler.stop");
      await fs.writeFile(`${values.profile}.cpuprofile`, JSON.stringify(cpuProfile));
      await fs.writeFile(`${values.profile}.heapprofile`, JSON.stringify(heap));
    }
    assert(result && typeof result === "object" && "paths" in result);
    assert.deepEqual(result.paths.toSorted(), files);
    assert.equal(
      result.estimatedBytes,
      values.estimate ? files.length * Math.max(4096, fileBytes) : 0,
    );
    const processCpuMs = (cpu.user + cpu.system) / 1000;
    console.log(
      JSON.stringify({
        label: values.label,
        node: process.version,
        platform: process.platform,
        source,
        ownerSha256: createHash("sha256")
          .update(readFileSync(new URL(baseUrl ?? ownerUrl)))
          .digest("hex"),
        files: files.length,
        sourceBytes: files.length * fileBytes,
        estimate: values.estimate,
        wallMs,
        spawnCount,
        processCpuMs,
        childCpuMs: childMs,
        cpuMs: processCpuMs + (childMs ?? 0),
        allocationMethod: exact ? "v8-exact" : "v8-sampled",
        allocatedBytes: exact ? exactBytes : allocated(heap.head),
        memoryBefore,
        memoryAfter,
        loadBefore,
        loadAfter,
      }),
    );
  } finally {
    Object.defineProperty(childProcess, "spawn", { value: spawn });
    syncBuiltinESMExports();
    profiler.disconnect();
    hooks.deregister();
  }
}
