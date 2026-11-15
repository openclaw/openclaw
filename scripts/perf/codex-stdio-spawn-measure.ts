/**
 * Synthetic transport-owner proof; no Gateway, credentials, or live state.
 * Prepare: node --import ./scripts/tsx.mjs scripts/perf/codex-stdio-spawn-measure.ts
 *   --root <task-owned-directory> --prepare
 * Measure (serial): same command --root <directory> --output <results.json>
 * Defaults: 62k actual workspace files / 1.1 GB, 6k session metadata rows,
 * an INERT sparse 35 GiB file, five A/A pairs and five A/B pairs per delay/mode.
 * The fixture is cwd context, not scanned by the transport. The sparse file is
 * not an agent database or a claim to reproduce btrfs reservation stalls.
 *
 * Acceptance, fixed before running: one real child per request; identical bytes,
 * natural exit and drained stderr; with a 350 ms injected synchronous exec wait,
 * candidate main-loop gap <150 ms. Expose cold startup, warm throughput, main and
 * total CPU, sampled allocation, and worker heap cost. Report >20% adverse changes
 * against A/A spread; no automatic acceptance of the worker's resource overhead.
 * Timing and allocation passes are separate. Cold = new transport/process,
 * not eviction of filesystem caches. The injection blocks at the spawn boundary
 * then invokes native spawn; it does not reproduce a stalled kernel exec itself.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import type { CodexStdioChild } from "../../extensions/codex/src/app-server/stdio-worker.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    output: { type: "string" },
    samples: { type: "string", default: "5" },
    files: { type: "string", default: "62000" },
    "workspace-bytes": { type: "string", default: "1100000000" },
    sessions: { type: "string", default: "6000" },
    "stream-mib": { type: "string", default: "16" },
    sample: { type: "string" },
    mode: { type: "string", default: "timing" },
    "delay-ms": { type: "string", default: "350" },
  },
});
assert(values.root, "--root must name a task-owned synthetic directory");
const root = path.resolve(values.root);
const fixture = path.join(root, "codex-stdio-fixture");
const manifestPath = path.join(fixture, "manifest.json");
const integer = (raw: string, minimum = 1) => {
  const number = Number(raw);
  assert(Number.isSafeInteger(number) && number >= minimum, `Invalid integer: ${raw}`);
  return number;
};

if (values.prepare) {
  await mkdir(root, { recursive: true });
  await mkdir(fixture); // Never replace an existing fixture or unknown files.
  for (const directory of ["workspace", "home", "tmp"]) {
    await mkdir(path.join(fixture, directory));
  }
  const files = integer(values.files);
  const workspaceBytes = integer(values["workspace-bytes"], files);
  const sessions = integer(values.sessions);
  const size = Math.floor(workspaceBytes / files);
  const content = randomBytes(size + 1);
  for (let index = 0; index < files; index++) {
    const directory = path.join(fixture, "workspace", `directory-${Math.floor(index / 250)}`);
    if (index % 250 === 0) {
      await mkdir(directory);
    }
    await writeFile(
      path.join(directory, `file-${index}.txt`),
      content.subarray(0, size + (index < workspaceBytes % files ? 1 : 0)),
    );
  }
  await writeFile(
    path.join(fixture, "session-metadata.json"),
    JSON.stringify({
      data: Array.from({ length: sessions }, (_, index) => ({
        id: `synthetic-session-${index}`,
        name: `Synthetic session ${index}`,
        cwd: path.join(fixture, "workspace", `directory-${Math.floor((index % files) / 250)}`),
        preview: "Synthetic catalog preview; no production data.",
        createdAt: 1_700_000_000 + index,
        updatedAt: 1_700_000_000 + index,
      })),
      nextCursor: null,
    }),
  );
  const sparsePath = path.join(fixture, "inert-size-shape-not-a-database.sparse");
  const sparse = await open(sparsePath, "wx");
  try {
    await sparse.truncate(35 * 1024 ** 3);
  } finally {
    await sparse.close();
  }
  const sparseStat = await stat(sparsePath);
  const manifest = {
    format: "codex-stdio-benchmark-v1",
    files,
    workspaceBytes,
    sessions,
    sparseLogicalBytes: sparseStat.size,
    sparseAllocatedBytes: sparseStat.blocks * 512,
    limitation:
      "Inert size fixture; not an agent DB, filesystem stress, or Gateway catalog benchmark.",
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
} else if (values.sample) {
  await measureSample();
} else {
  await measureSeries();
}

type WorkerMetrics = {
  type: "codex-stdio-benchmark";
  calls: number;
  blockedMs: number;
  cpuMs: number;
  initialHeapBytes: number;
  peakHeapBytes: number;
  finalHeapBytes: number;
  sampledAllocationBytes: number | null;
};

type SampleRecord = {
  series: string;
  sample: number;
  arm: string;
  owner: string;
  mode: string;
  delayMs: number;
  coldMs: number;
  coldGapMs: number;
  coldCpu: { mainCpuMs: number; totalCpuMs: number };
  warmMs: number;
  warmGapMs: number;
  warmCpu: { mainCpuMs: number; totalCpuMs: number };
  throughputMiBPerSec: number;
  mainSampledAllocationBytes: number | null;
  worker: WorkerMetrics | null;
};

async function measureSample() {
  assert(values.sample === "native" || values.sample === "worker");
  assert(values.mode === "timing" || values.mode === "allocation");
  const delayMs = integer(values["delay-ms"], 0);
  const { spawnCodexStdio } = await import("../../extensions/codex/src/app-server/stdio-worker.js");
  const { readSpawnProbe } = await import("./codex-stdio-spawn-preload.mjs");
  const payload = await readFile(path.join(fixture, "session-metadata.json"));
  const repeats = Math.max(
    1,
    Math.ceil((integer(values["stream-mib"]) * 1024 ** 2) / payload.length),
  );
  const bytes = repeats * payload.length;
  const expected = createHash("sha256");
  for (let index = 0; index < repeats; index++) {
    expected.update(payload);
  }
  const expectedDigest = expected.digest("hex");
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  let workerMetrics: WorkerMetrics | undefined;
  const observeWorker = (worker: Worker) =>
    worker.on("message", (message: WorkerMetrics) => {
      if (message.type === "codex-stdio-benchmark") {
        workerMetrics = message;
      }
    });
  process.on("worker", observeWorker);
  const initialHeap = process.memoryUsage().heapUsed;
  let peakHeap = initialHeap;
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    ticks++;
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 10);
  const cpu = () => ({ main: process.threadCpuUsage(), total: process.cpuUsage() });
  const used = (before: ReturnType<typeof cpu>) => {
    const main = process.threadCpuUsage(before.main);
    const total = process.cpuUsage(before.total);
    return {
      mainCpuMs: (main.user + main.system) / 1000,
      totalCpuMs: (total.user + total.system) / 1000,
    };
  };
  const initialCpu = cpu();
  const started = performance.now();
  const command =
    "/* CODEX_STDIO_BENCH_CHILD */ process.stderr.write('ready\\n'); process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stderr.write('drained\\n'));";
  const options = {
    cwd: path.join(fixture, "workspace"),
    env: { PATH: process.env.PATH, HOME: path.join(fixture, "home") },
  };
  const child: CodexStdioChild =
    values.sample === "worker"
      ? spawnCodexStdio(process.execPath, ["-e", command], options)
      : spawn(process.execPath, ["-e", command], { ...options, stdio: "pipe" });
  const closed = once(child, "close");
  void closed.catch(() => {}); // Startup errors are first observed by ready below.
  const digest = createHash("sha256");
  let received = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    received += chunk.length;
    digest.update(chunk);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => reject(new Error("Synthetic child closed before readiness")));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes("ready\n")) {
        resolve();
      }
    });
  });
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  try {
    await ready;
    const coldMs = performance.now() - started;
    const coldCpu = used(initialCpu);
    await delay(20); // Let the first delayed heartbeat observe a main-thread stall.
    const coldGapMs = maxGapMs;
    maxGapMs = 0;
    last = performance.now();
    const warmCpu = cpu();
    const warmStarted = performance.now();
    for (let index = 0; index < repeats; index++) {
      if (!child.stdin.write(payload)) {
        await once(child.stdin, "drain");
      }
    }
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    const warmMs = performance.now() - warmStarted;
    const warmUsed = used(warmCpu);
    assert.equal(received, bytes);
    assert.equal(digest.digest("hex"), expectedDigest);
    assert.equal(stderr, "ready\ndrained\n");
    assert.equal(child.exitCode, 0);
    const probe = readSpawnProbe();
    assert.equal(
      probe.calls + (workerMetrics?.calls ?? 0),
      1,
      "injection must reach exactly one native spawn",
    );
    assert(probe.blockedMs + (workerMetrics?.blockedMs ?? 0) >= delayMs - 1);
    if (values.sample === "worker") {
      assert(workerMetrics, "Worker metrics/preload did not arrive");
    }
    const profile = await inspector?.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, entry) => total + sum(entry), 0);
    console.log(
      JSON.stringify({
        owner: values.sample,
        mode: values.mode,
        delayMs,
        coldMs,
        coldGapMs,
        coldCpu,
        warmMs,
        warmGapMs: maxGapMs,
        warmCpu: warmUsed,
        throughputMiBPerSec: bytes / 1024 ** 2 / (warmMs / 1000),
        bytes,
        ticks,
        mainHeapInitialBytes: initialHeap,
        mainHeapPeakBytes: peakHeap,
        mainHeapFinalBytes: process.memoryUsage().heapUsed,
        mainSampledAllocationBytes: profile ? sum(profile.profile.head) : null,
        worker: workerMetrics ?? null,
        mainNativeSpawnCalls: probe.calls,
        responsive: values.sample === "native" || coldGapMs < 150,
        loadavg: loadavg(),
        pid: process.pid,
      }),
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    process.off("worker", observeWorker);
    inspector?.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function measureSeries() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.format, "codex-stdio-benchmark-v1");
  const samples = integer(values.samples, 5);
  const records: SampleRecord[] = [];
  const preload = new URL("./codex-stdio-spawn-preload.mjs", import.meta.url).href;
  const tooling = new URL("../tsx.mjs", import.meta.url).href;
  for (const mode of ["timing", "allocation"]) {
    for (const delayMs of [0, 350]) {
      for (const series of ["AA", "AB"]) {
        for (let sample = 0; sample < samples; sample++) {
          for (const arm of ["A", "B"]) {
            const owner = series === "AB" && arm === "B" ? "worker" : "native";
            const child = spawn(
              process.execPath,
              [
                "--import",
                tooling,
                fileURLToPath(import.meta.url),
                "--root",
                root,
                "--sample",
                owner,
                "--mode",
                mode,
                "--delay-ms",
                String(delayMs),
                "--stream-mib",
                values["stream-mib"],
              ],
              {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                env: {
                  PATH: process.env.PATH,
                  HOME: path.join(fixture, "home"),
                  TMPDIR: path.join(fixture, "tmp"),
                  NODE_OPTIONS: `--import=${preload}`,
                  OPENCLAW_STDIO_BENCH_SAMPLE: "1",
                  OPENCLAW_STDIO_BENCH_DELAY_MS: String(delayMs),
                  OPENCLAW_STDIO_BENCH_ALLOCATION: mode === "allocation" ? "1" : "0",
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            const [code] = await once(child, "close");
            assert.equal(code, 0, stderr);
            const record: SampleRecord = {
              series,
              sample,
              arm,
              ...JSON.parse(stdout.trim().split("\n").at(-1)!),
            };
            records.push(record);
            console.log(JSON.stringify(record));
          }
        }
      }
    }
  }
  const groups = new Map<string, SampleRecord[]>();
  for (const record of records) {
    const key = `${record.series}/${record.arm}/${record.mode}/${record.delayMs}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const metrics: Record<string, (row: SampleRecord) => number | null> = {
    coldMs: (row) => row.coldMs,
    coldGapMs: (row) => row.coldGapMs,
    coldMainCpuMs: (row) => row.coldCpu.mainCpuMs,
    coldTotalCpuMs: (row) => row.coldCpu.totalCpuMs,
    warmMs: (row) => row.warmMs,
    warmGapMs: (row) => row.warmGapMs,
    warmMainCpuMs: (row) => row.warmCpu.mainCpuMs,
    warmTotalCpuMs: (row) => row.warmCpu.totalCpuMs,
    throughputMiBPerSec: (row) => row.throughputMiBPerSec,
    mainSampledAllocationBytes: (row) => row.mainSampledAllocationBytes,
    workerCpuMs: (row) => row.worker?.cpuMs ?? 0,
    workerPeakHeapBytes: (row) => row.worker?.peakHeapBytes ?? 0,
    workerSampledAllocationBytes: (row) =>
      row.worker?.sampledAllocationBytes ?? (row.mode === "allocation" ? 0 : null),
  };
  const summaries = Object.fromEntries(
    [...groups].map(([key, rows]) => [
      key,
      Object.fromEntries(
        Object.entries(metrics).map(([metric, read]) => {
          const sorted = rows
            .map(read)
            .filter((value) => value !== null)
            .toSorted((a, b) => a - b);
          return [
            metric,
            sorted.length
              ? {
                  median: sorted[Math.floor(sorted.length / 2)],
                  p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                  min: sorted[0],
                  max: sorted.at(-1),
                  samples: sorted.length,
                }
              : null,
          ];
        }),
      ),
    ]),
  );
  const result = {
    fixture: manifest,
    acceptance:
      "350ms stall: candidate max host gap <150ms; exact bytes and natural exit. Report every >20% adverse resource/latency change against AA controls.",
    summaries,
    records,
  };
  if (values.output) {
    await writeFile(path.resolve(values.output), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ summaries }));
}
