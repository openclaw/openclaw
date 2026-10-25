/**
 * Focused publication transport attribution, not a Gateway end-to-end benchmark.
 * Run five alternating pairs with separate new state directories, adding --spawn-broker
 * on the broker side; use identical flags for A/A timing controls:
 * node --import ./scripts/tsx.mjs scripts/perf/publication-spawn-measure.ts \
 *   --state-dir /absolute/new-fixture --operations 200 --resident-mib 4096
 * Repeat separately with --allocation for collected-object sampling. For promotion:
 * node --trace-gc-nvp --import ./scripts/tsx.mjs scripts/perf/publication-spawn-measure.ts \
 *   --state-dir /absolute/new-traced-fixture --operations 200 --resident-mib 4096
 * Capture stdout/stderr together; sum promoted bytes between MEASURE_START/MEASURE_END.
 * Traced results have their own baseline and cannot supply timing gates. GC, allocation,
 * and promotion describe the parent; parent+broker CPU excludes Git subprocess CPU.
 */
import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "transport-owner": { type: "string" },
    "spawn-broker": { type: "boolean", default: false },
    "resident-mib": { type: "string", default: "0" },
    operations: { type: "string", default: "2000" },
    "start-at": { type: "string", default: "0" },
    allocation: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values["state-dir"], "Pass a new isolated --state-dir");
assert(
  !(values.allocation && values["cpu-profile"]),
  "Choose allocation or CPU profiling, not both",
);
const root = path.resolve(values["state-dir"]);
await mkdir(root); // Refuse an existing fixture rather than adopting another run's state.
await mkdir(path.join(root, "tmp"));
await mkdir(path.join(root, "home"));
const operations = parseStrictIntegerOption({
  raw: values.operations,
  label: "operations",
  min: 200,
  fallback: 2000,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "start-at",
  min: 0,
  fallback: 0,
});
const residentMiB = parseStrictIntegerOption({
  raw: values["resident-mib"],
  label: "resident-mib",
  min: 0,
  fallback: 0,
});
const traced = process.execArgv.includes("--trace-gc-nvp");
// Keep executable routing, but do not pass credentials or the operator's configuration to Git.
const syntheticEnv = {
  PATH: process.env.PATH,
  ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
  HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  ...Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [
      `SYNTHETIC_PUBLICATION_${index}`,
      `fixture-${index}-${"x".repeat(64)}`,
    ]),
  ),
};
// Preserve Node's native environment access costs while removing inherited secrets.
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}
Object.assign(process.env, syntheticEnv);
await writeFile(process.env.GIT_CONFIG_GLOBAL!, "");
const repository = path.join(root, "repository");
await mkdir(repository);
const git = (args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
git(["init", "--initial-branch=main"]);
git(["config", "user.name", "Synthetic Fixture"]);
git(["config", "user.email", "fixture@example.invalid"]);
await writeFile(path.join(repository, "fixture.txt"), "synthetic publication fixture\n");
git(["add", "fixture.txt"]);
git(["-c", "commit.gpgsign=false", "commit", "-m", "Synthetic fixture"]);
const head = git(["rev-parse", "HEAD"]);

let baselineLoads = 0;
if (values["transport-owner"]) {
  const original = new URL(
    "../../src/gateway/github-publication-git-transport.ts",
    import.meta.url,
  );
  const replacement = pathToFileURL(path.resolve(values["transport-owner"]));
  assert.equal(path.dirname(fileURLToPath(original)), path.dirname(fileURLToPath(replacement)));
  assert.notEqual(original.href, replacement.href, "Baseline must be a sibling file");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url === original.href) {
        baselineLoads++;
        return { ...resolved, url: replacement.href };
      }
      return resolved;
    },
  });
}
const { runPublicationCommand } =
  await import("../../src/gateway/github-publication-git-transport.js");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.js");
setDiagnosticsEnabledForProcess(true);
assert(!values["transport-owner"] || baselineLoads > 0, "Baseline transport owner was not loaded");
const { createSpawnBrokerHost } = await import("../../src/process/spawn-broker/host.js");
const { runWithSpawnBroker } = await import("../../src/process/spawn-broker/context.js");
const broker = values["spawn-broker"] ? createSpawnBrokerHost() : undefined;
const commands = [
  { args: ["rev-parse", "--verify", "HEAD^{commit}"], expected: head },
  { args: ["config", "--get", "user.name"], expected: "Synthetic Fixture" },
  { args: ["ls-files"], expected: "fixture.txt" },
  { args: ["show", "HEAD:fixture.txt"], expected: "synthetic publication fixture" },
];
const operation = async (index: number) => {
  const command = commands[index % commands.length]!;
  const result = await runWithSpawnBroker(broker, () =>
    runPublicationCommand(["git", ...command.args], { cwd: repository }),
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString("utf8").trim(), command.expected);
};
let observer: PerformanceObserver | undefined;
const loop = monitorEventLoopDelay({ resolution: 1 });
const inspector = new Session();
const spawnDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, "spawn");
assert(spawnDescriptor && typeof spawnDescriptor.value === "function");
try {
  await broker?.ready();
  // A global root keeps touched synthetic RSS alive through all measured operations.
  Reflect.set(
    globalThis,
    Symbol.for("openclaw.perf.publicationResident"),
    Array.from({ length: residentMiB }, () => Buffer.alloc(1024 * 1024, 1)),
  );
  for (let index = 0; index < 100; index++) {
    await operation(index);
  }

  const pauses: Record<string, number[]> = {
    minor: [],
    major: [],
    incremental: [],
    weak: [],
    other: [],
  };
  let started = Infinity;
  let ended = Infinity;
  function observeGc(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      if (entry.startTime < started || entry.startTime >= ended) {
        continue;
      }
      const kind: unknown = Reflect.get(entry, "detail")?.kind;
      const name =
        kind === constants.NODE_PERFORMANCE_GC_MINOR
          ? "minor"
          : kind === constants.NODE_PERFORMANCE_GC_MAJOR
            ? "major"
            : kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL
              ? "incremental"
              : kind === constants.NODE_PERFORMANCE_GC_WEAKCB
                ? "weak"
                : "other";
      pauses[name]!.push(entry.duration);
    }
  }
  function summary(input: number[]) {
    const sorted = input.toSorted((a, b) => a - b);
    const percentile = (fraction: number) =>
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    const totalMs = input.reduce((sum, value) => sum + value, 0);
    return {
      count: input.length,
      totalMs,
      meanMs: totalMs / (input.length || 1),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      maxMs: sorted.at(-1) ?? 0,
    };
  }
  observer = new PerformanceObserver((list) => observeGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  const samplingInterval = 32768;
  const spawnTimes: number[] = [];
  const spawnCpuTimes: number[] = [];
  Object.defineProperty(ChildProcess.prototype, "spawn", {
    ...spawnDescriptor,
    value: new Proxy(spawnDescriptor.value, {
      apply(target, receiver, args: unknown[]) {
        const before = performance.now();
        const cpuBefore = process.threadCpuUsage();
        try {
          return Reflect.apply(target, receiver, args);
        } finally {
          const cpu = process.threadCpuUsage(cpuBefore);
          spawnTimes.push(performance.now() - before);
          spawnCpuTimes.push((cpu.user + cpu.system) / 1000);
        }
      },
    }),
  });
  if (startAt) {
    assert(startAt > Date.now(), "Preparation missed the shared start deadline");
    await delay(startAt - Date.now());
  }
  const clockTicks =
    process.platform === "linux"
      ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
      : undefined;
  function combinedCpuMs() {
    const pids = [process.pid, ...(broker?.pid ? [broker.pid] : [])];
    if (clockTicks) {
      return pids.reduce((sum, pid) => {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return sum + ((Number(fields[11]) + Number(fields[12])) * 1000) / clockTicks;
      }, 0);
    }
    const rows = execFileSync("ps", ["-p", pids.join(","), "-o", "time="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.equal(rows.length, pids.length, "A measured process exited before its CPU snapshot");
    return rows.reduce((sum, row) => {
      const [days, clock] = row.trim().includes("-") ? row.trim().split("-") : ["0", row.trim()];
      const parts = clock!.split(":").map(Number);
      const seconds = parts.reduce((value, part) => value * 60 + part, 0) + Number(days) * 86400;
      assert(Number.isFinite(seconds), `Invalid ps CPU time: ${row}`);
      return sum + seconds * 1000;
    }, 0);
  }
  const combinedCpuBefore = combinedCpuMs();
  if (values.allocation || values["cpu-profile"]) {
    inspector.connect();
  }
  if (values.allocation) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (values["cpu-profile"]) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const latencies: number[] = [];
  if (traced) {
    console.error("MEASURE_START");
  }
  loop.enable();
  const startedAtEpochMs = Date.now();
  const threadBefore = process.threadCpuUsage();
  const processBefore = process.cpuUsage();
  started = performance.now();
  try {
    for (let index = 0; index < operations; index++) {
      const before = performance.now();
      await operation(index);
      latencies.push(performance.now() - before);
    }
  } finally {
    ended = performance.now();
    loop.disable();
    Object.defineProperty(ChildProcess.prototype, "spawn", spawnDescriptor);
  }
  const threadCpu = process.threadCpuUsage(threadBefore);
  const processCpu = process.cpuUsage(processBefore);
  if (traced) {
    console.error("MEASURE_END");
  }
  let allocation:
    | { samplingInterval: number; bytes: number; bytesPerOperation: number }
    | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    const bytes = allocated(profile.head);
    allocation = { samplingInterval, bytes, bytesPerOperation: bytes / operations };
  }
  let cpuProfile: string | undefined;
  if (values["cpu-profile"]) {
    const { profile } = await inspector.post("Profiler.stop");
    cpuProfile = path.join(root, "publication-spawn.cpuprofile");
    await writeFile(cpuProfile, JSON.stringify(profile));
  }
  const parentAndBrokerCpuMs = combinedCpuMs() - combinedCpuBefore;
  await delay(10); // Deliver deferred GC observations; filter by the measured window above.
  observeGc(observer.takeRecords());
  observer.disconnect();
  const totalGc = summary(Object.values(pauses).flat());
  const result = {
    workload: "publication-transport",
    mode: values.allocation
      ? "allocation"
      : values["cpu-profile"]
        ? "cpu-profile"
        : traced
          ? "traced"
          : "untraced",
    spawnBroker: Boolean(broker),
    residentMiB,
    operations,
    environmentKeys: Object.keys(process.env).length,
    baselineLoads,
    startedAtEpochMs,
    durationMs: ended - started,
    mainThreadCpuMsPerOperation: (threadCpu.user + threadCpu.system) / 1000 / operations,
    processCpuMsPerOperation: (processCpu.user + processCpu.system) / 1000 / operations,
    latency: summary(latencies),
    synchronousSpawn: summary(spawnTimes),
    synchronousSpawnCpu: summary(spawnCpuTimes),
    synchronousSpawnCpuMsPerOperation:
      spawnCpuTimes.reduce((sum, value) => sum + value, 0) / operations,
    parentAndBrokerCpu: {
      totalMs: parentAndBrokerCpuMs,
      msPerOperation: parentAndBrokerCpuMs / operations,
      snapshotResolutionMs: clockTicks
        ? 1000 / clockTicks
        : process.platform === "darwin"
          ? 10
          : 1000,
      source: `${clockTicks ? "/proc stat" : "ps time"}; snapshots outside the timed window; excludes Git children`,
    },
    allocation,
    cpuProfile,
    gc: {
      total: totalGc,
      msPerOperation: totalGc.totalMs / operations,
      byKind: Object.fromEntries(
        Object.entries(pauses).map(([kind, samples]) => [kind, summary(samples)]),
      ),
    },
    eventLoop: {
      count: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
  };
  const json = JSON.stringify(result, null, 2);
  await writeFile(values.output ?? path.join(root, "result.json"), json + "\n");
  console.log(json);
} finally {
  loop.disable();
  observer?.disconnect();
  inspector.disconnect();
  Object.defineProperty(ChildProcess.prototype, "spawn", spawnDescriptor);
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.perf.publicationResident"));
  await broker?.close();
}
