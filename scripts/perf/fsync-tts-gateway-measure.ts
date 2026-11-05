// Synthetic TTS persistence over real Gateway WebSocket RPCs; approved benchmark hosts only.
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import workerThreads from "node:worker_threads";
import {
  GATEWAY_GC_TRACE_MARKER,
  writeGatewayGcTraceMarker,
  readGatewayGcTrace,
} from "../lib/gateway-bench-profile.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "41622" },
    operations: { type: "string", default: "120" },
    "interval-ms": { type: "string", default: "500" },
    "fsync-delay-ms": { type: "string", default: "50" },
    "start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    baseline: { type: "boolean", default: false },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({
    raw: String(values[name] ?? ""),
    label: `--${name}`,
    min,
    fallback: min,
  });
assert.ok(values["state-dir"], "--state-dir must name a new synthetic directory");
assert.ok(global.gc, "Run with --expose-gc");
const operations = integer("operations", 1);
const intervalMs = integer("interval-ms", 1);
const fsyncDelayMs = integer("fsync-delay-ms", 0);
const startAt = integer("start-at", 0);
const port = integer("port", 40000);
assert.ok(port <= 65535);
const directory = path.resolve(values["state-dir"]);
fs.mkdirSync(directory);
for (const name of ["home", "tmp", "workspace"]) {
  fs.mkdirSync(path.join(directory, name));
}
const configPath = path.join(directory, "openclaw.json");
const prefsPath = path.join(directory, "tts.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { main: { workspace: path.join(directory, "workspace") } },
    },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_TTS_PREFS: prefsPath,
    TMPDIR: path.join(directory, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
  },
});
// Materialize these two baseline files alongside their originals with `git show <base>:<path>`.
const baselineLoads = new Set<string>();
if (values.baseline) {
  const replacements = new Map(
    ["../../src/gateway/server-methods/tts.ts", "../../src/tts/tts-settings-writes.ts"].map(
      (relative) => {
        const original = new URL(relative, import.meta.url).href;
        return [original, original.replace(/\.ts$/, ".baseline.ts")];
      },
    ),
  );
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const replacement = replacements.get(resolved.url);
      if (!replacement) {
        return resolved;
      }
      baselineLoads.add(resolved.url);
      return { ...resolved, url: replacement };
    },
  });
}
const profilePath = path.join(directory, "main-isolate");
writeGatewayGcTraceMarker("identify-start", profilePath);
global.gc();
writeGatewayGcTraceMarker("identify-stop", profilePath);
// Give every isolate the same injected storage delay; counts stay in this fixture's buffer.
const workerProbe = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
workerThreads.setEnvironmentData("openclaw.synthetic-tts-fsync", {
  control: workerProbe.buffer,
  delayMs: fsyncDelayMs,
});
const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = new Proxy(OriginalWorker, {
  construct(target, args: ConstructorParameters<typeof OriginalWorker>) {
    const [filename, options] = args;
    return new target(filename, {
      ...options,
      execArgv: [
        ...(options?.execArgv ??
          process.execArgv.filter((arg) => arg !== "--expose-gc" && arg !== "--trace-gc-nvp")),
        "--import",
        new URL("./fsync-tts-worker-preload.mjs", import.meta.url).href,
      ],
    });
  },
});
syncBuiltinESMExports();
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const ready = Promise.withResolvers<void>();
const peer = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  mode: "webchat",
  platform: "web",
  instanceId: "synthetic-tts-fsync",
  scopes: ["operator.admin"],
  requestTimeoutMs: 60_000,
  onHelloOk: () => ready.resolve(),
  onConnectError: (error) => ready.reject(error),
});
peer.start();
await ready.promise;
async function run(index: number) {
  const enabled = index % 2 === 0;
  const result = await peer.request<{ enabled: boolean }>(
    enabled ? "tts.enable" : "tts.disable",
    {},
  );
  assert.equal(result.enabled, enabled);
  assert.equal(
    JSON.parse(await fs.promises.readFile(prefsPath, "utf8")).tts.auto,
    enabled ? "always" : "off",
  );
}
const coldStarted = performance.now();
await run(-1);
const coldWriteMs = performance.now() - coldStarted;
assert.equal(baselineLoads.size, values.baseline ? 2 : 0, "Both baseline owners must be loaded");
const originalSync = fs.fsyncSync;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let syncCalls = 0;
let blockedMs = 0;
let measuring = false;
fs.fsyncSync = (fd) => {
  if (!measuring) {
    return originalSync(fd);
  }
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
// Calibrate the probe through the real RPC before accepting a relocated-worker comparison.
measuring = true;
Atomics.store(workerProbe, 0, 1);
await run(-1);
measuring = false;
Atomics.store(workerProbe, 0, 0);
assert.equal(
  syncCalls + Atomics.load(workerProbe, 1),
  2,
  "The probe must observe both durable flushes",
);
assert.equal(syncCalls, values.baseline ? 2 : 0, "The requested TTS owner must perform the write");
syncCalls = 0;
blockedMs = 0;
Atomics.store(workerProbe, 1, 0);
Atomics.store(workerProbe, 2, 0);
const loop = monitorEventLoopDelay({ resolution: 10 });
const collections: Array<{ kind: number; ms: number }> = [];
let begin = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((entries) =>
  recordGcCollections(entries.getEntries(), collections, begin, end),
);
observer.observe({ entryTypes: ["gc"] });
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
// Include worker collection cost so moving writes off main cannot hide their GC work.
function processGcTrace(logPath: string) {
  let capturing = false;
  const processCollections: Array<{ kind: string; ms: number; promoted: number }> = [];
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    if (line.startsWith(GATEWAY_GC_TRACE_MARKER)) {
      const value = JSON.parse(line.slice(GATEWAY_GC_TRACE_MARKER.length));
      if (value.pid === process.pid && value.profilePath === profilePath) {
        if (value.phase === "heap-start") {
          capturing = true;
        }
        if (value.phase === "heap-stop") {
          capturing = false;
        }
      }
      continue;
    }
    if (!capturing) {
      continue;
    }
    const trace = /^\[(\d+):(0x[\da-f]+)(?::\d+)?\]\s+\d+\s+ms:\s+(.*)$/i.exec(line);
    if (!trace || Number(trace[1]) !== process.pid) {
      continue;
    }
    const fields = trace[3] ?? "";
    const entry = fields.startsWith("GC: ")
      ? JSON.parse(fields.slice(4))
      : {
          gc: /(?:^|\s)gc=(\S+)/.exec(fields)?.[1],
          pause: Number(/(?:^|\s)pause=(\S+)/.exec(fields)?.[1]),
          promoted: Number(/(?:^|\s)promoted=(\S+)/.exec(fields)?.[1]),
        };
    if (!entry.gc) {
      continue;
    }
    assert.ok(Number.isFinite(entry.pause) && Number.isSafeInteger(entry.promoted));
    processCollections.push({ kind: entry.gc, ms: entry.pause, promoted: entry.promoted });
  }
  return {
    scope: "all-process-isolates",
    total: distribution(processCollections.map((entry) => entry.ms)),
    minor: distribution(
      processCollections.filter((entry) => entry.kind === "s").map((entry) => entry.ms),
    ),
    major: distribution(
      processCollections.filter((entry) => entry.kind !== "s").map((entry) => entry.ms),
    ),
    promotedBytes: processCollections.reduce((sum, entry) => sum + entry.promoted, 0),
  };
}
try {
  console.log("FSYNC_READY", JSON.stringify({ startAt, pid: process.pid }));
  if (startAt) {
    assert.ok(Date.now() < startAt, "Missed --start-at after warmup");
    // Keep the candidate's idle-retiring writer warm while both sides await placement.
    while (Date.now() + 10_000 < startAt) {
      await delay(10_000);
      await run(-1);
    }
    assert.ok(Date.now() < startAt, "Missed --start-at during warmup");
    await delay(startAt - Date.now());
  }
  const latencies: number[] = [];
  loop.enable();
  const cpuStart = process.cpuUsage();
  const mainCpuStart = process.threadCpuUsage();
  writeGatewayGcTraceMarker("heap-start", profilePath);
  begin = performance.now();
  measuring = true;
  Atomics.store(workerProbe, 0, 1);
  for (let index = 0; index < operations; index++) {
    const started = performance.now();
    await run(index);
    latencies.push(performance.now() - started);
    await delay(Math.max(0, begin + (index + 1) * intervalMs - performance.now()));
  }
  end = performance.now();
  measuring = false;
  Atomics.store(workerProbe, 0, 0);
  writeGatewayGcTraceMarker("heap-stop", profilePath);
  const cpu = process.cpuUsage(cpuStart);
  const mainCpu = process.threadCpuUsage(mainCpuStart);
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
      "Real isolated Gateway TTS enable/disable RPCs; equal synchronous-flush simulation across main and worker isolates",
    node: process.version,
    baseline: values.baseline,
    operations,
    intervalMs,
    fsyncDelayMs,
    syncCalls,
    blockedMs,
    workerSyncCalls: Atomics.load(workerProbe, 1),
    workerBlockedMs: Atomics.load(workerProbe, 2) / 1000,
    totalSyncCalls: syncCalls + Atomics.load(workerProbe, 1),
    coldWriteMs,
    blockedMsPerMinute: (blockedMs * 60_000) / (end - begin),
    elapsedMs: end - begin,
    cpuMs: (cpu.user + cpu.system) / 1000,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
    latency: distribution(latencies),
    mainGc: {
      total: gc(),
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    processGc: values["gc-log"] ? processGcTrace(path.resolve(values["gc-log"])) : null,
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
  measuring = false;
  Atomics.store(workerProbe, 0, 0);
  fs.fsyncSync = originalSync;
  workerThreads.Worker = OriginalWorker;
  workerThreads.setEnvironmentData("openclaw.synthetic-tts-fsync", undefined);
  syncBuiltinESMExports();
  loop.disable();
  observer.disconnect();
  peer.stop();
  await server.close({ reason: "synthetic TTS flush measurement finished" });
}
