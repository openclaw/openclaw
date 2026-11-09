/**
 * Native copy owner proof; no Gateway, Git selection, database or template timing.
 * Seed a NEW scratch filesystem, then alternate bundled baseline/candidate owners:
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-copy-measure.ts
 *   --root /scratch/btrfs-proof --seed
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-copy-measure.ts
 *   --root /scratch/btrfs-proof --owner /scratch/owner.mjs --label baseline-1
 * Bundle each revision's provisioned-copy.ts with esbuild --packages=external.
 * Install that revision's fs-safe dependency beside the bundle. --profile saves CPU
 * and sampled allocation stacks (including collected objects) outside the repo.
 * Acceptance: >=5x lower wall time and exact V8 allocation for 50,000 selected
 * files; identical bytes/mode/mtime/path set, independent writes and CoW extents.
 * Run A/A controls and >=5 interleaved pairs in fresh processes/destinations.
 * Natural GC; verification and cleanup excluded. No production data is read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { copyProvisionedPaths } from "../../src/agents/worktrees/provisioned-copy.js";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    owner: { type: "string" },
    label: { type: "string", default: "candidate" },
    seed: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});
assert(values.root, "--root is required");
assert(/^[a-zA-Z0-9-]+$/.test(values.label), "--label must be a single filename segment");
const root = path.resolve(values.root);
const source = path.join(root, "source");
const paths = Array.from(
  { length: 50_000 },
  (_, i) => `prepared/${Math.floor(i / 100)}/${i % 100}.bin`,
);
const payload = Buffer.alloc(20_000, 120);
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
const childCpuMs = () => {
  const fields = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / ticksPerSecond;
};
const timestamp = new Date("2020-01-02T03:04:05Z");
if (values.seed) {
  await fs.mkdir(source);
  for (let i = 0; i < 62_000; i++) {
    const relative = i < paths.length ? paths[i]! : `source/${Math.floor(i / 100)}/${i % 100}.bin`;
    const file = path.join(source, relative);
    if (i % 100 === 0) {
      await fs.mkdir(path.dirname(file), { recursive: true });
    }
    payload.writeUInt32LE(i, 0);
    await fs.writeFile(file, payload, { mode: 0o640 });
    await fs.utimes(file, timestamp, timestamp);
  }
  await fs.writeFile(path.join(source, ".gitignore"), "prepared/\n");
  await fs.writeFile(path.join(source, ".worktreeinclude"), "prepared/**\n");
  console.log(JSON.stringify({ files: 62_000, bytes: 62_000 * payload.length }));
} else {
  assert(values.owner, "--owner is required");
  const owner: { copyProvisionedPaths: typeof copyProvisionedPaths } = await import(
    pathToFileURL(path.resolve(values.owner)).href
  );
  const destination = path.join(root, values.label);
  await fs.mkdir(destination);
  const profiler = values.profile ? new inspector.Session() : undefined;
  try {
    if (profiler) {
      profiler.connect();
      await profiler.post("Profiler.enable");
      await profiler.post("HeapProfiler.startSampling", {
        samplingInterval: 65536,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await profiler.post("Profiler.start");
    }
    let authorityCalls = 0;
    const memoryBefore = process.memoryUsage();
    const beforeLoad = loadavg();
    const childrenBefore = childCpuMs();
    const allocationBefore = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocationBefore), "Node must expose exact V8 allocation counters");
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    const copied = await owner.copyProvisionedPaths(source, destination, paths, {
      assertCurrent() {
        authorityCalls++;
      },
    });
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
    const childrenMs = childCpuMs() - childrenBefore;
    const parentCpuMs = (cpu.user + cpu.system) / 1000;
    const measured = {
      label: values.label,
      wallMs,
      cpuMs: parentCpuMs + childrenMs,
      parentCpuMs,
      childCpuMs: childrenMs,
      allocatedBytes,
      authorityCalls,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      beforeLoad,
      afterLoad: loadavg(),
    };
    if (profiler) {
      const { profile: cpuProfile } = await profiler.post("Profiler.stop");
      const { profile: heapProfile } = await profiler.post("HeapProfiler.stopSampling");
      await fs.writeFile(`${values.profile}.cpuprofile`, JSON.stringify(cpuProfile));
      await fs.writeFile(`${values.profile}.heapprofile`, JSON.stringify(heapProfile));
    }
    assert.deepEqual(copied, paths.toSorted());
    for (let i = 0; i < paths.length; i++) {
      const file = path.join(destination, paths[i]!);
      const stat = await fs.stat(file);
      assert.equal(stat.mode & 0o7777, 0o640);
      assert.equal(stat.mtimeMs, timestamp.getTime());
      payload.writeUInt32LE(i, 0);
      assert.deepEqual(await fs.readFile(file), payload);
    }
    const entries = await listDirectoryTreeStrict(destination);
    assert.equal(entries.filter((entry) => !entry.dirent.isDirectory()).length, paths.length);
    const extents = execFileSync(
      "btrfs",
      ["filesystem", "du", "-s", "--raw", source, destination],
      { encoding: "utf8" },
    );
    await fs.writeFile(path.join(destination, paths[0]!), "independent destination");
    payload.writeUInt32LE(0, 0);
    assert.deepEqual(await fs.readFile(path.join(source, paths[0]!)), payload);
    console.log(JSON.stringify({ ...measured, verifiedFiles: paths.length, extents }));
  } finally {
    profiler?.disconnect();
    await fs.rm(destination, { recursive: true });
  }
}
