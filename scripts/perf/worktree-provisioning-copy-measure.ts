/**
 * Native copy owner proof; no Gateway, Git selection, database or template timing.
 * Seed a NEW scratch filesystem, then alternate bundled baseline/candidate owners:
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-copy-measure.ts
 *   --root /scratch/btrfs-proof --seed
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-provisioning-copy-measure.ts
 *   --root /scratch/btrfs-proof --owner /scratch/owner.mjs --label baseline-1
 * Bundle each revision's provisioned-copy.ts with esbuild --packages=external.
 * --dependencies selects the 65,880-file directory-include dependency fixture.
 * Install that revision's fs-safe dependency beside the bundle. --profile saves CPU
 * and sampled allocation stacks (including collected objects) outside the repo.
 * --resident-gib 8 retains touched memory in the parent and runs the owner in a
 * worker with live host authority handshakes, exposing large-Gateway fork costs.
 * Node versions without exact allocation counters report sampled allocation.
 * Guarded-to-batched acceptance: >=5x lower wall time and V8 allocation for
 * 50,000 files or the 65,880-file dependency fixture. Resident-parent follow-up:
 * >=5x lower wall and parent spawn count, no >20% CPU/allocation regression.
 * Both require identical bytes/mode/mtime/path set, independent writes and CoW
 * extents. Gateway provisionCopy must be <10 seconds.
 * Run A/A controls and >=5 interleaved pairs in fresh processes/destinations.
 * Natural GC; verification and cleanup excluded. No production data is read.
 */
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { copyProvisionedPaths } from "../../src/agents/worktrees/provisioned-copy.js";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import type { ProvisionCopyDetails } from "../../src/infra/fs-safe-copy-worker-contract.js";
import {
  dependencyFileBytes,
  dependencyFixturePaths,
  seedDependencyFixture,
} from "./worktree-provisioning-dependency-fixture.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string" },
    owner: { type: "string" },
    label: { type: "string", default: "candidate" },
    seed: { type: "boolean", default: false },
    profile: { type: "string" },
    dependencies: { type: "boolean", default: false },
    "resident-gib": { type: "string" },
  },
});
assert(values.root, "--root is required");
assert(/^[a-zA-Z0-9-]+$/.test(values.label), "--label must be a single filename segment");
const root = path.resolve(values.root);
const source = path.resolve(values.source ?? path.join(root, "source"));
const paths = values.dependencies
  ? dependencyFixturePaths()
  : Array.from({ length: 50_000 }, (_, i) => `prepared/${Math.floor(i / 100)}/${i % 100}.bin`);
const payload = Buffer.alloc(values.dependencies ? dependencyFileBytes : 20_000, 120);
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
const childCpuMs = () => {
  const fields = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / ticksPerSecond;
};
const timestamp = new Date("2020-01-02T03:04:05Z");
if (isMainThread && values["resident-gib"] !== undefined && !values.seed) {
  const gib = Number(values["resident-gib"]);
  assert(Number.isSafeInteger(gib) && gib >= 0 && gib <= 16, "--resident-gib must be 0–16");
  const memory = Array.from({ length: gib }, () => Buffer.alloc(1024 ** 3, 120));
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL(import.meta.url), {
    argv: process.argv.slice(2),
    workerData: decision.buffer,
  });
  worker.on("message", () => {
    Atomics.store(decision, 0, 1);
    Atomics.notify(decision, 0);
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)),
    );
  });
  assert(memory.every((bytes) => bytes[0] === 120));
} else if (values.seed) {
  await fs.mkdir(source);
  if (values.dependencies) {
    await seedDependencyFixture(source);
  } else {
    for (let i = 0; i < 62_000; i++) {
      const relative =
        i < paths.length ? paths[i]! : `source/${Math.floor(i / 100)}/${i % 100}.bin`;
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
  }
  console.log(
    JSON.stringify({
      files: values.dependencies ? paths.length : 62_000,
      bytes: (values.dependencies ? paths.length : 62_000) * payload.length,
    }),
  );
} else {
  assert(values.owner, "--owner is required");
  const owner: { copyProvisionedPaths: typeof copyProvisionedPaths } = await import(
    pathToFileURL(path.resolve(values.owner)).href
  );
  const destination = path.join(root, values.label);
  await fs.mkdir(destination);
  const exactAllocation = Number.isFinite(getHeapStatistics().total_allocated_bytes);
  const profiler = values.profile || !exactAllocation ? new inspector.Session() : undefined;
  const spawn = childProcess.spawn;
  let spawnCount = 0;
  let spawnMs = 0;
  Object.defineProperty(childProcess, "spawn", {
    value: (...args: Parameters<typeof spawn>) => {
      const started = performance.now();
      const child = spawn(...args);
      spawnCount++;
      spawnMs += performance.now() - started;
      return child;
    },
  });
  try {
    if (profiler) {
      profiler.connect();
      if (values.profile) {
        await profiler.post("Profiler.enable");
      }
      await profiler.post("HeapProfiler.startSampling", {
        samplingInterval: 65536,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      if (values.profile) {
        await profiler.post("Profiler.start");
      }
    }
    let authorityCalls = 0;
    const decision = isMainThread ? undefined : new Int32Array(workerData);
    const copyDetails: ProvisionCopyDetails = {
      copier: "portable",
      batchCount: 0,
      sourceBytes: 0,
      spawnCount: 0,
      spawnMs: 0,
      childMs: 0,
      authorityChecks: 0,
      authorityMs: 0,
    };
    const memoryBefore = process.memoryUsage();
    const beforeLoad = loadavg();
    const childrenBefore = childCpuMs();
    const allocationBefore = getHeapStatistics().total_allocated_bytes;
    const cpuBefore = process.cpuUsage();
    const start = performance.now();
    const copied = await owner.copyProvisionedPaths(source, destination, paths, {
      copyDetails,
      assertCurrent() {
        const started = performance.now();
        authorityCalls++;
        if (decision) {
          Atomics.store(decision, 0, 0);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no Window target origin.
          parentPort?.postMessage("authority");
          while (Atomics.load(decision, 0) === 0) {
            Atomics.wait(decision, 0, 0);
          }
        }
        copyDetails.authorityChecks++;
        copyDetails.authorityMs += performance.now() - started;
      },
    });
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuBefore);
    let allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
    const childrenMs = childCpuMs() - childrenBefore;
    const parentCpuMs = (cpu.user + cpu.system) / 1000;
    const measured = {
      label: values.label,
      node: process.version,
      architecture: process.arch,
      residentGiB: values["resident-gib"],
      pageTableKiB: Number(
        readFileSync("/proc/self/status", "utf8").match(/^VmPTE:\s+(\d+) kB$/m)?.[1],
      ),
      wallMs,
      cpuMs: parentCpuMs + childrenMs,
      parentCpuMs,
      childCpuMs: childrenMs,
      allocationMethod: exactAllocation ? "v8-exact" : "v8-sampled",
      spawnCount,
      spawnMs,
      copyDetails: copyDetails.sourceBytes || copyDetails.batchCount ? copyDetails : undefined,
      authorityCalls,
      authorityMs: copyDetails.authorityMs,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      beforeLoad,
      afterLoad: loadavg(),
    };
    if (profiler) {
      if (values.profile) {
        const { profile: cpuProfile } = await profiler.post("Profiler.stop");
        await fs.writeFile(`${values.profile}.cpuprofile`, JSON.stringify(cpuProfile));
      }
      const { profile: heapProfile } = await profiler.post("HeapProfiler.stopSampling");
      if (!exactAllocation) {
        const allocated = (node: typeof heapProfile.head): number =>
          node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
        allocatedBytes = allocated(heapProfile.head);
      }
      if (values.profile) {
        await fs.writeFile(`${values.profile}.heapprofile`, JSON.stringify(heapProfile));
      }
    }
    assert.deepEqual(copied, paths.toSorted());
    for (let i = 0; i < paths.length; i++) {
      const file = path.join(destination, paths[i]!);
      const stat = await fs.stat(file);
      assert.equal(stat.mode & 0o7777, values.dependencies && i % 97 === 0 ? 0o755 : 0o640);
      assert.equal(stat.mtimeMs, timestamp.getTime());
      assert.equal(
        (await fs.stat(file, { bigint: true })).mtimeNs,
        (await fs.stat(path.join(source, paths[i]!), { bigint: true })).mtimeNs,
      );
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
    console.log(
      JSON.stringify({ ...measured, allocatedBytes, verifiedFiles: paths.length, extents }),
    );
  } finally {
    Object.defineProperty(childProcess, "spawn", { value: spawn });
    profiler?.disconnect();
    await fs.rm(destination, { recursive: true });
  }
}
