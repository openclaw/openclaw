/**
 * Synthetic staged-result read through the production worker/main-thread boundary.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/staged-workspace-manifest-measure.ts prepare <scratch> <files> [control]
 * [OPENCLAW_BENCH_BASELINE_DIR=<sparse source>] node --expose-gc --import ./scripts/tsx.mjs scripts/perf/staged-workspace-manifest-measure.ts run <scratch> <label> [allocation|cpu|bytes|timing] [summary|materialize]
 * Prepare immutable Git receipts separately, then alternate fresh-process arms,
 * including same-source A/A controls. The control has 62k unchanged 18,000-byte
 * logical files and one edit; the pathological receipt changes every file.
 * Repeated content deliberately shares a Git blob: no production data or external
 * service. This measures the staged owner, NOT sessions.github.action transport.
 * Acceptance: bounded main-thread payload, identical accepted content count/hash,
 * actionable oversized rejection. Summary compares the manifest refs/count; materialize
 * also verifies first/last payload digests. Includes one forced GC after loading
 * for retention evidence; timings include that GC. Report process/main CPU separately.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const [mode, directory, argument = "250000", instrument, operation = "summary"] =
  process.argv.slice(2);
assert(directory && (mode === "prepare" || mode === "run"));
const scratch = path.resolve(directory);
const root = path.join(scratch, "repository");
const ref = "refs/openclaw/worker-results/synthetic-staged-read";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (mode === "prepare") {
  const files = Number(argument);
  assert(Number.isSafeInteger(files) && files > 0);
  const control = instrument === "control";
  await fs.mkdir(root, { recursive: true });
  execFileSync("git", ["-C", root, "init", "--quiet", "--template="]);
  const content = Buffer.alloc(control ? 18_000 : 1, 65);
  const digest = hash(content);
  const entries = Array.from({ length: files }, (_, index) => ({
    path: `source/${String(Math.floor(index / 1000)).padStart(4, "0")}/file-${String(index).padStart(7, "0")}.bin`,
    type: "file",
    mode: 0o644,
    size: content.byteLength,
    sha256: digest,
  }));
  // Deliberately bypass the producer only to construct an over-limit receipt;
  // the production consumer still authenticates and validates every byte.
  const directories = [
    "source",
    ...Array.from(
      { length: Math.ceil(files / 1000) },
      (_, index) => `source/${String(index).padStart(4, "0")}`,
    ),
  ].map((pathname) => ({ path: pathname, type: "directory", mode: 0o700 }));
  const manifest = (selectedEntries: typeof entries, includeDirectories: boolean) =>
    JSON.stringify({
      version: 1,
      baseCommit: null,
      entries: [...(includeDirectories ? directories : []), ...selectedEntries].toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    });
  const base = manifest(control ? entries.slice(1) : [], control);
  const current = manifest(entries, true);
  const message = `OpenClaw worker workspace result\nversion 2\nbase-ref sha256:${hash(base)}\ncurrent-ref sha256:${hash(current)}\nbase-bytes ${Buffer.byteLength(base)}\ncurrent-bytes ${Buffer.byteLength(current)}\n\n${base}${current}`;
  const inputPath = path.join(scratch, "input");
  const file = await fs.open(inputPath, "w");
  try {
    await file.write(`blob\nmark :1\ndata ${content.byteLength}\n`);
    await file.write(content);
    await file.write(
      `\ncommit ${ref}\nauthor Synthetic <synthetic@example.invalid> 0 +0000\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\ndata ${Buffer.byteLength(message)}\n${message}\ndeleteall\n`,
    );
    const changed = control ? entries.slice(0, 1) : entries;
    for (let offset = 0; offset < changed.length; offset += 1000) {
      await file.write(
        changed
          .slice(offset, offset + 1000)
          .map((entry) => `M 100644 :1 ${entry.path}\n`)
          .join(""),
      );
    }
    await file.write("done\n");
  } finally {
    await file.close();
  }
  const input = await fs.open(inputPath, "r");
  try {
    execFileSync("git", ["-C", root, "fast-import", "--quiet", "--force"], {
      stdio: [input.fd, "pipe", "pipe"],
    });
  } finally {
    await input.close();
    await fs.rm(inputPath);
  }
  const fixture = {
    files,
    changedFiles: control ? 1 : files,
    control,
    logicalBytes: files * content.byteLength,
    metadataBytes: Buffer.byteLength(message),
    expectedContentSha256: digest,
  };
  await fs.writeFile(path.join(scratch, "fixture.json"), JSON.stringify(fixture));
  console.log(JSON.stringify(fixture));
} else {
  assert(global.gc, "--expose-gc is required");
  if (process.env.OPENCLAW_BENCH_BASELINE_DIR) {
    await import("./worker-retained-heap-preload.js");
  }
  const { readStagedWorkerWorkspaceResult, withStagedWorkerWorkspaceResult } =
    await import("../../src/gateway/worker-environments/workspace-result-staging.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const fixture = JSON.parse(await fs.readFile(path.join(scratch, "fixture.json"), "utf8"));
  const inspector = new Session();
  global.gc();
  const before = process.memoryUsage();
  let peakHeap = before.heapUsed;
  let peakExternal = before.external;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakExternal = Math.max(peakExternal, memory.external);
  };
  const timer = setInterval(sample, 5);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  await delay(20);
  if (instrument === "allocation") {
    await startCollectedHeapSampling(inspector, 32768);
  } else if (instrument === "cpu") {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const elu = performance.eventLoopUtilization();
  const started = performance.now();
  let loadMs: number | undefined;
  let loadedHeap: number | undefined;
  let retainedHeap: number | undefined;
  let readEntries = 0;
  let contentBytes = 0;
  let snapshotSerializedBytes: number | undefined;
  let error: string | undefined;
  const digest = createHash("sha256");
  try {
    const observe = async (snapshot: {
      changedEntryCount?: number;
      changedEntries?: unknown[];
      baseManifestRef: string;
      currentManifestRef: string;
      stagingRoot?: string;
    }) => {
      loadMs = performance.now() - started;
      sample();
      loadedHeap = process.memoryUsage().heapUsed;
      global.gc?.();
      retainedHeap = process.memoryUsage().heapUsed;
      readEntries = snapshot.changedEntryCount ?? snapshot.changedEntries?.length ?? 0;
      digest.update(snapshot.baseManifestRef).update(snapshot.currentManifestRef);
      if (snapshot.stagingRoot) {
        for (const index of new Set([0, fixture.control ? 0 : fixture.files - 1])) {
          const filename = `source/${String(Math.floor(index / 1000)).padStart(4, "0")}/file-${String(index).padStart(7, "0")}.bin`;
          const content: Buffer = await fs.readFile(path.join(snapshot.stagingRoot, filename));
          assert.equal(hash(content), fixture.expectedContentSha256);
          contentBytes += content.byteLength;
          digest.update(filename).update(content);
        }
      }
      assert.equal(readEntries, fixture.changedFiles);
      if (instrument === "bytes") {
        snapshotSerializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
      }
    };
    if (operation === "materialize") {
      await withStagedWorkerWorkspaceResult({ root, stagedResultRef: ref }, observe);
    } else {
      assert.equal(operation, "summary");
      await observe(await readStagedWorkerWorkspaceResult(root, ref));
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const elapsedMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpu);
  const mainCpu = process.threadCpuUsage(threadCpu);
  const eventLoop = performance.eventLoopUtilization(elu);
  clearInterval(timer);
  let allocatedBytes: number | undefined;
  if (instrument === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, entry) => sum + entry.size, 0);
  } else if (instrument === "cpu") {
    const { profile } = await inspector.post("Profiler.stop");
    await fs.writeFile(path.join(scratch, `${argument}.cpuprofile`), JSON.stringify(profile));
  }
  if (instrument === "allocation" || instrument === "cpu") {
    inspector.disconnect();
  }
  await delay(10);
  loop.disable();
  const result = {
    label: argument,
    baseline: Boolean(process.env.OPENCLAW_BENCH_BASELINE_DIR),
    operation,
    instrument: instrument ?? "timing",
    fixture,
    node: process.version,
    platform: process.platform,
    load: os.loadavg(),
    loadMs,
    elapsedMs,
    before,
    loadedHeap,
    retainedHeap,
    peakHeap,
    peakExternal,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    eventLoop,
    loopP99Ms: loop.percentile(99) / 1e6,
    loopMaxMs: loop.max / 1e6,
    allocatedBytes,
    readEntries,
    contentBytes,
    snapshotSerializedBytes,
    outputDigest: digest.digest("hex"),
    error,
  };
  await fs.writeFile(path.join(scratch, `${argument}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await drainGlobalSingletonLifecycleState();
}
