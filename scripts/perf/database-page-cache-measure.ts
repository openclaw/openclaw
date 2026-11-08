// Synthetic Linux maintenance-owner proof; run only on an approved benchmark host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Session, type HeapProfiler, type Profiler } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeGatewayGcTraceMarker, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "trace-log": { type: "string" },
    "start-at": { type: "string", default: "0" },
    passes: { type: "string", default: "1" },
    cold: { type: "boolean" },
    profile: { type: "boolean" },
    "prepare-only": { type: "boolean" },
    "owner-dir": { type: "string" },
    "barrier-dir": { type: "string" },
    side: { type: "string" },
  },
});
assert(process.platform === "linux" && values["state-dir"] && values.output);
assert(global.gc && values["trace-log"], "Use --expose-gc --trace-gc-nvp and --trace-log");
const root = path.resolve(values["state-dir"]);
const passes = Number(values.passes);
assert(Number.isSafeInteger(passes) && passes > 0);
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_SKIP_CHANNELS: "1",
});
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_PAGE_CACHE_OWNER_DIR = path.resolve(values["owner-dir"]);
  const preload = new URL("./database-page-cache-preload.mjs", import.meta.url).href;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`;
  await import("./database-page-cache-preload.mjs");
}
writeGatewayGcTraceMarker("identify-start");
global.gc();
writeGatewayGcTraceMarker("identify-stop");
const [
  { prepareGatewayStartupSessions },
  { warmGatewayDatabasePageCache },
  state,
  agents,
  diagnostics,
] = await Promise.all([
  import("../../src/gateway/server-startup-session-migration.js"),
  import("../../src/gateway/server-database-page-cache.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/infra/diagnostic-events.js"),
]);
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
const reports: string[] = [];
const log = {
  info: (message: string) => reports.push(message),
  warn: (message: string) => {
    throw new Error(message);
  },
};
const databases = await prepareGatewayStartupSessions({ cfg: config, log });
assert(databases.length > 0);
const paths = [
  path.join(root, "state", "openclaw.sqlite"),
  ...databases.map(({ database }) => database.path),
].filter(fs.existsSync);
const sizes = paths.map((pathname) => ({
  name: path.basename(pathname),
  bytes: fs.statSync(pathname).size,
}));
let active = false;
let statCalls = 0;
const originalStat = fs.statSync;
fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
  if (active) {
    statCalls++;
  }
  return Reflect.apply(originalStat, fs, args);
}) as typeof fs.statSync;
syncBuiltinESMExports();
let requests = 0;
diagnostics.setDiagnosticsEnabledForProcess(true);
const unsubscribe = diagnostics.onInternalDiagnosticEvent((event) => {
  if (
    active &&
    event.type === "worker.request" &&
    event.phase === "started" &&
    event.kind === "sqlite_read"
  ) {
    requests++;
  }
});
const clockTicks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
const childCpuMs = () => {
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / clockTicks;
};
let brokerPid: number | undefined;
const { startGatewaySpawnBroker, runWithSpawnBroker } =
  await import("../../src/process/spawn-broker/context.js");
const broker = await startGatewaySpawnBroker({
  onReady: (pid) => {
    brokerPid = pid;
  },
  onStartupFailure: (message) => {
    throw new Error(message);
  },
});
assert(broker && brokerPid, "The benchmark requires the Gateway spawn broker");
const brokerCpuMs = () => {
  const stat = fs.readFileSync(`/proc/${brokerPid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return (fields.slice(11, 15).reduce((sum, value) => sum + Number(value), 0) * 1000) / clockTicks;
};
const results = [];
try {
  for (let pass = 0; !values["prepare-only"] && pass < passes; pass++) {
    if (values.cold) {
      // Evict only the explicitly named synthetic files; never drop host caches.
      execFileSync("python3", [
        "-c",
        "import os,sys\nfor p in sys.argv[1:]:\n f=os.open(p,os.O_RDONLY); os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED); os.close(f)",
        ...paths,
      ]);
    }
    reports.length = 0;
    requests = 0;
    statCalls = 0;
    global.gc();
    await delay(50);
    if (values["barrier-dir"]) {
      assert(values.side === "baseline" || values.side === "candidate");
      const barrier = path.resolve(values["barrier-dir"]);
      fs.writeFileSync(path.join(barrier, `${pass}.${values.side}.ready`), "ready\n");
      const startFile = path.join(barrier, `${pass}.start`);
      while (!fs.existsSync(startFile)) {
        await delay(100);
      }
      const startAt = Number(fs.readFileSync(startFile, "utf8"));
      assert(Date.now() < startAt, "Missed shared start barrier");
      await delay(startAt - Date.now());
    } else if (pass === 0 && Number(values["start-at"])) {
      const startAt = Number(values["start-at"]);
      assert(Date.now() < startAt, "Missed shared start time");
      await delay(startAt - Date.now());
    }
    const profilePath = `${values.output}.pass-${pass}`;
    const inspector = new Session();
    const gc: Array<{ durationMs: number; kind: number }> = [];
    let captureStart = Infinity;
    let captureEnd = Infinity;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= captureStart && entry.startTime < captureEnd) {
          gc.push({ durationMs: entry.duration, kind: Reflect.get(entry, "detail").kind });
        }
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    await delay(10);
    if (values.profile) {
      inspector.connect();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.setSamplingInterval", { interval: 1000 });
      await inspector.post("Profiler.start");
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    loop.reset();
    const childCpuStart = childCpuMs() + brokerCpuMs();
    writeGatewayGcTraceMarker("diagnostics-start", profilePath);
    const cpuStart = process.cpuUsage(),
      threadStart = process.threadCpuUsage();
    captureStart = performance.now();
    active = true;
    const signal = AbortSignal.timeout(240_000);
    await runWithSpawnBroker(broker, () =>
      warmGatewayDatabasePageCache({ databases, signal, log }),
    );
    signal.throwIfAborted();
    await diagnostics.waitForDiagnosticEventsDrained();
    captureEnd = performance.now();
    const cpu = process.cpuUsage(cpuStart),
      thread = process.threadCpuUsage(threadStart);
    const childrenMs = childCpuMs() + brokerCpuMs() - childCpuStart;
    active = false;
    writeGatewayGcTraceMarker("diagnostics-stop", profilePath);
    loop.disable();
    let sampledBytes: number | undefined;
    let heapProfile: HeapProfiler.SamplingHeapProfile | undefined;
    let cpuProfile: Profiler.Profile | undefined;
    if (values.profile) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      heapProfile = profile;
      cpuProfile = (await inspector.post("Profiler.stop")).profile;
      inspector.disconnect();
    }
    // Drain observer delivery, without adding idle samples to the operation's loop histogram.
    await delay(0);
    observer.disconnect();
    if (heapProfile) {
      const total = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
      sampledBytes = total(heapProfile.head);
      fs.writeFileSync(`${profilePath}.heap.json`, JSON.stringify(heapProfile));
    }
    if (cpuProfile) {
      fs.writeFileSync(`${profilePath}.cpu.json`, JSON.stringify(cpuProfile));
    }
    const tail = (kind: number) => {
      const samples = gc
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.durationMs)
        .toSorted((a, b) => a - b);
      return {
        samples: samples.length,
        p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? null,
        p99Ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? null,
        maxMs: samples.at(-1) ?? null,
      };
    };
    results.push({
      pass,
      elapsedMs: captureEnd - captureStart,
      sampledBytes,
      cpuMs: (cpu.user + cpu.system) / 1000,
      childCpuMs: childrenMs,
      mainCpuMs: (thread.user + thread.system) / 1000,
      requests,
      statCalls,
      reports: [...reports],
      loop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 },
      gc: {
        totalMs: gc.reduce((sum, entry) => sum + entry.durationMs, 0),
        minor: tail(1),
        major: tail(4),
        other: gc.filter((entry) => entry.kind !== 1 && entry.kind !== 4),
      },
      promotion: readGatewayGcTrace(values["trace-log"]!, profilePath, "diagnostics"),
    });
    fs.writeFileSync(
      values.output!,
      JSON.stringify(
        { sizes, cold: Boolean(values.cold), profiled: Boolean(values.profile), results },
        null,
        2,
      ),
    );
  }
} finally {
  active = false;
  unsubscribe();
  fs.statSync = originalStat;
  syncBuiltinESMExports();
  await broker.close();
  await agents.closeOpenClawAgentDatabasesAsync(root);
  await state.closeOpenClawStateDatabaseAsync();
}
