// Synthetic owner-boundary proof; run only on an approved benchmark host.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "container-owner": { type: "string" },
    "media-owner": { type: "string" },
    operations: { type: "string", default: "120" },
    "interval-ms": { type: "string", default: "500" },
    "fsync-delay-ms": { type: "string", default: "50" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
assert.ok(values["state-dir"], "--state-dir must name a new synthetic directory");
assert.ok(global.gc, "Run with --expose-gc");
const operations = integer("operations", 1);
const intervalMs = integer("interval-ms", 1);
const fsyncDelayMs = integer("fsync-delay-ms", 0);
const startAt = integer("start-at", 0);
const directory = path.resolve(values["state-dir"]);
fs.mkdirSync(directory);
for (const name of ["home", "tmp"]) {
  fs.mkdirSync(path.join(directory, name));
}
process.env.HOME = path.join(directory, "home");
process.env.OPENCLAW_HOME = process.env.HOME;
process.env.OPENCLAW_STATE_DIR = directory;
process.env.TMPDIR = path.join(directory, "tmp");
const { createContainerEnvFile }: typeof import("../../src/infra/container-env-file.js") =
  await import(
    values["container-owner"]
      ? pathToFileURL(path.resolve(values["container-owner"])).href
      : "../../src/infra/container-env-file.js"
  );
const { writePlaybackTranscodeCache }: typeof import("../../src/media/store.js") = await import(
  values["media-owner"]
    ? pathToFileURL(path.resolve(values["media-owner"])).href
    : "../../src/media/store.js"
);
const payload = Buffer.from("synthetic playback cache");
async function run(index: number) {
  const file = await createContainerEnvFile({ SYNTHETIC: String(index) });
  try {
    assert.equal(await fs.promises.readFile(file.path, "utf8"), `SYNTHETIC=${index}\n`);
  } finally {
    await file.cleanup();
  }
  const cached = await writePlaybackTranscodeCache({
    buffer: payload,
    fileName: "v2-fsync-probe.mp4",
    maxBytes: payload.length,
    tempPrefix: ".fsync-probe",
  });
  assert.deepEqual(await fs.promises.readFile(cached), payload);
}
await run(-1);
const profilePath = path.join(directory, "main-isolate");
writeGatewayGcTraceMarker("identify-start", profilePath);
global.gc();
writeGatewayGcTraceMarker("identify-stop", profilePath);
const originalSync = fs.fsyncSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let syncCalls = 0;
let blockedMs = 0;
fs.fsyncSync = (fd) => {
  syncCalls++;
  const started = performance.now();
  try {
    Atomics.wait(sleeper, 0, 0, fsyncDelayMs);
    originalSync(fd);
  } finally {
    blockedMs += performance.now() - started;
  }
};
syncBuiltinESMExports();
const loop = monitorEventLoopDelay({ resolution: 10 });
const collections: Array<{ kind: number; ms: number }> = [];
let begin = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((entries) =>
  recordGcCollections(entries.getEntries(), collections, begin, end),
);
observer.observe({ entryTypes: ["gc"] });
loop.enable();
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
  };
}
try {
  console.log("FSYNC_READY", JSON.stringify({ startAt, pid: process.pid }));
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after warmup");
    await delay(startAt - Date.now());
  }
  loop.reset();
  const latencies: number[] = [];
  const cpuStart = process.cpuUsage();
  writeGatewayGcTraceMarker("heap-start", profilePath);
  begin = performance.now();
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    await run(index);
    latencies.push(performance.now() - started);
    await delay(Math.max(0, begin + (index + 1) * intervalMs - performance.now()));
  }
  end = performance.now();
  writeGatewayGcTraceMarker("heap-stop", profilePath);
  const cpu = process.cpuUsage(cpuStart);
  loop.disable();
  await nextTurn();
  observer.disconnect();
  const gc = (kind?: number) =>
    distribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const result = {
    scope:
      "Real container scratch and playback cache owners; injected synchronous fsync delay, not Gateway throughput",
    node: process.version,
    operations,
    intervalMs,
    fsyncDelayMs,
    syncCalls,
    blockedMs,
    blockedMsPerMinute: (blockedMs * 60_000) / (end - begin),
    elapsedMs: end - begin,
    cpuMs: (cpu.user + cpu.system) / 1000,
    latency: distribution(latencies),
    gc: {
      total: gc(),
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: values["gc-log"]
      ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath)
      : null,
    eventLoop: {
      samples: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
  };
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.fsyncSync = originalSync;
  syncBuiltinESMExports();
  loop.disable();
  observer.disconnect();
}
