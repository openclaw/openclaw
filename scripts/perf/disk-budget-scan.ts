/**
 * Disk-budget owner benchmark using real synthetic files; no Gateway or operator state.
 * Run on each revision with the same Node flags and fixture path:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/disk-budget-scan.ts \
 *   --state-dir "$PWD/.local/disk-budget-bench" --files 10000 --iterations 5
 * Timing is untraced; allocation sampling is a separate pass and includes collected objects.
 * Compare counterbalanced base/candidate runs. Fixture creation is outside every sample.
 * --module can select a prepared baseline module exporting readSessionPhysicalDiskUsage.
 * --profile writes the allocation profile for attribution; peak heap is sampled every 5 ms.
 * --worker runs the same scan owner in a worker isolate (RSS remains process-wide).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, Worker } from "node:worker_threads";
import { readSessionPhysicalDiskUsage } from "../../src/config/sessions/disk-budget-files.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      files: { type: "string", default: "10000" },
      iterations: { type: "string", default: "5" },
      module: { type: "string" },
      profile: { type: "string" },
      worker: { type: "boolean" },
    },
  });
  if (values.worker && isMainThread) {
    const worker = new Worker(new URL(import.meta.url), { argv: process.argv.slice(2) });
    const code = await new Promise<number>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", resolve);
    });
    process.exitCode = code;
    return;
  }
  assert(values["state-dir"], "--state-dir must name a task-owned synthetic fixture directory");
  assert(globalThis.gc, "Run with --expose-gc");
  assert(
    Number.isFinite(getHeapStatistics().total_allocated_bytes),
    "Native allocation counters require Node 26.12+",
  );
  const files = Number(values.files);
  const iterations = Number(values.iterations);
  const readUsage: typeof readSessionPhysicalDiskUsage = values.module
    ? (await import(pathToFileURL(path.resolve(values.module)).href)).readSessionPhysicalDiskUsage
    : readSessionPhysicalDiskUsage;
  assert(Number.isSafeInteger(files) && files > 0);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  const root = path.resolve(values["state-dir"]);
  const sessionsDir = path.join(root, "agents/main/sessions");
  const storePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.mkdirSync(path.join(sessionsDir, "cold"), { recursive: true });
  const writeFixture = (file: string, bytes: number) => {
    if (fs.existsSync(file)) {
      assert.equal(fs.statSync(file).size, bytes, `Unexpected fixture size: ${file}`);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, bytes);
    fs.closeSync(fd);
  };
  writeFixture(storePath, 1024 * 1024);
  writeFixture(`${storePath}-wal`, 65536);
  writeFixture(`${storePath}-shm`, 32768);
  for (let index = 0; index < files; index++) {
    const hash = index.toString(16).padStart(64, "0");
    const relative =
      index % 5 === 0
        ? `skills-prompts/sha256/${hash.slice(0, 2)}/${hash}.txt`
        : index % 2 === 0
          ? `cold/session-${index}.jsonl.zst`
          : `session-${index}.jsonl`;
    writeFixture(path.join(sessionsDir, relative), 128);
  }
  const expected = { databaseWalBytes: 65536, totalBytes: 1024 * 1024 + 65536 + files * 128 };
  const scan = async () => assert.deepEqual(await readUsage(storePath), expected);
  await scan();
  await scan();
  globalThis.gc();
  const retainedBefore = process.memoryUsage();
  const samples = [];
  let gcMs = 0;
  let gcCount = 0;
  let gcMaxMs = 0;
  const gcEvents: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcEvents.push(entry);
      gcMs += entry.duration;
      gcCount++;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const hostLoadBefore = os.loadavg();
  let peakHeapUsedBytes = retainedBefore.heapUsed;
  const heapSampler = setInterval(() => {
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, process.memoryUsage().heapUsed);
  }, 5);
  for (let index = 0; index < iterations; index++) {
    const cpuStart = process.cpuUsage();
    const threadCpuStart = process.threadCpuUsage();
    const start = performance.now();
    const allocatedBefore = getHeapStatistics().total_allocated_bytes;
    await scan();
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const threadCpu = process.threadCpuUsage(threadCpuStart);
    samples.push({
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      threadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
      allocatedBytes,
    });
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  clearInterval(heapSampler);
  observer.disconnect();
  globalThis.gc();
  const retainedAfter = process.memoryUsage();
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let index = 0; index < iterations; index++) {
    await scan();
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  if (values.profile) {
    fs.writeFileSync(values.profile, JSON.stringify(profile));
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        worker: !isMainThread,
        files,
        iterations,
        samples,
        allocatedBytesPerScan:
          profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
        gc: {
          count: gcCount,
          totalMs: gcMs,
          maxMs: gcMaxMs,
          events: gcEvents.map((entry) => entry.toJSON()),
        },
        retainedBefore,
        retainedAfter,
        peakHeapUsedBytes,
        hostLoadBefore,
        hostLoadAfter: os.loadavg(),
      },
      null,
      2,
    ),
  );
}

await main();
