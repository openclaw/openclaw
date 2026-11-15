/**
 * Actual quiescence owner with synthetic indexed registry/custody/engine boundaries.
 *
 * bun scripts/perf/local-workspace-quiescence-measure.ts --freeze <new-dir> --revision <base>
 * bun scripts/perf/local-workspace-quiescence-measure.ts --freeze <new-dir>
 * bun scripts/perf/local-workspace-quiescence-measure.ts --source <snapshot> --output <new-dir>
 * Add --allocation for a separate main-isolate sampling pass; never pool its timings.
 * Logical engine waits prove freeze placement without sleeping; hrtime/CPU measure
 * actual owner and log formatting work. This does not benchmark engine or DB throughput.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const { values } = parseArgs({
  options: {
    freeze: { type: "string" },
    revision: { type: "string" },
    source: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "2000" },
    warmup: { type: "string", default: "100" },
    allocation: { type: "boolean", default: false },
  },
});
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../..");
const relativeOwner = "src/agents/sandbox/local-workspace-quiescence.ts";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const harnessSha256 = hash(fs.readFileSync(script));
const json = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
if (values.freeze) {
  const target = path.resolve(values.freeze);
  fs.mkdirSync(target);
  const source = values.revision
    ? execFileSync("git", ["show", `${values.revision}:${relativeOwner}`], { cwd: root })
    : fs.readFileSync(path.join(root, relativeOwner));
  fs.writeFileSync(path.join(target, "owner.ts"), source);
  json(path.join(target, "source.json"), {
    revision:
      values.revision ??
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    workingOwner: !values.revision,
    ownerSha256: hash(source),
    harnessSha256,
  });
  console.log(target);
  process.exit(0);
}
assert(values.source && values.output, "Supply --source and a fresh --output directory");
const snapshot = path.resolve(values.source);
const output = path.resolve(values.output);
const source = fs.readFileSync(path.join(snapshot, "owner.ts"), "utf8");
const identity = JSON.parse(fs.readFileSync(path.join(snapshot, "source.json"), "utf8"));
assert.equal(hash(source), identity.ownerSha256);
assert.equal(
  harnessSha256,
  identity.harnessSha256,
  "Refresh snapshots after changing the launcher",
);
fs.mkdirSync(output);
const iterations = Number(values.iterations);
const warmup = Number(values.warmup);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(warmup) && warmup >= 0);

const boundary = String.raw`
const state = () => globalThis[Symbol.for("openclaw.quiescence.measure")];
export const BROWSER_BRIDGES = new Map();
export const DOCKER_SANDBOX_ENGINE = { id: "docker", command: "docker", displayName: "Docker" };
export const bindPodmanSandboxEngine = () => { throw new Error("Unexpected Podman fixture"); };
export const bindDockerPersistentTarget = () => DOCKER_SANDBOX_ENGINE;
export const dockerPersistentTargetFromEngineTarget = (value) => value;
export const dockerPersistentTargetToEngineTarget = (value) => value;
export const dockerPersistentExecContainerName = (attempt) => "stream-" + attempt;
export const validateSandboxContainerEngineTarget = async () => state().advance("target", 40);
export const assertSandboxRegistryRetirementCurrent = async () => state().authority();
export const assertSandboxRegistryEntryCurrent = () => { throw new Error("Unexpected file-read owner"); };
export const assertSandboxBrowserRegistryEntryCurrent = assertSandboxRegistryEntryCurrent;
export const readRegistry = async ({ workspaceDir }) => {
  state().advance("registry.container", 1);
  return { entries: state().containers.get(workspaceDir) ?? [] };
};
export const readBrowserRegistry = async ({ workspaceDir }) => {
  state().advance("registry.browser", 1);
  return { entries: state().browsers.get(workspaceDir) ?? [] };
};
export const createSandboxPersistentExecStore = () => ({
  databasePath: "/synthetic/state.sqlite", environment: {}, assertCurrent() {},
  async list() { state().advance("registry.stream", 1); return state().streams; },
  async assertCustodyCurrent() { state().authority(); },
});
export const execContainer = async (_engine, args) => state().command(args);
export const createSubsystemLogger = () => ({ info(message) { state().log(message); } });
export const removeSandboxRuntimeGeneration = () => { throw new Error("Unexpected retirement"); };
export const sandboxContainerShowsWorkspacePaths = () => { throw new Error("Unexpected file-read owner"); };
`;
const ownerDependencies = new Set([
  "../../logging/subsystem.js",
  "./browser-bridges.js",
  "./docker-persistent-target.js",
  "./docker.js",
  "./persistent-exec-store.js",
  "./persistent-exec.types.js",
  "./registry.js",
  "./manage.js",
  "./mount-plan.js",
]);
const bundle = path.join(output, "owner.mjs");
const compiled = await build({
  stdin: {
    contents: source,
    sourcefile: path.join(root, relativeOwner),
    resolveDir: path.join(root, "src/agents/sandbox"),
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  packages: "external",
  metafile: true,
  logLevel: "silent",
  plugins: [
    {
      name: "quiescence-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (
            (args.importer === relativeOwner || args.importer === path.join(root, relativeOwner)) &&
            ownerDependencies.has(args.path)
          ) {
            return { path: "boundary", namespace: "fixture" };
          }
          if (
            (args.importer === relativeOwner || args.importer === path.join(root, relativeOwner)) &&
            args.path === "../../infra/diagnostics-timeline.js"
          ) {
            return { path: path.join(root, "src/infra/diagnostics-timeline.ts"), external: true };
          }
          return undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: boundary,
          loader: "js",
        }));
      },
    },
  ],
});
fs.symlinkSync(path.join(root, "node_modules"), path.join(output, "node_modules"), "dir");
const inputs = Object.fromEntries(
  [...Object.keys(compiled.metafile.inputs), "src/infra/diagnostics-timeline.ts", "pnpm-lock.yaml"]
    .filter((name) => !name.startsWith("fixture:") && name !== relativeOwner)
    .map((name) => [name, hash(fs.readFileSync(path.resolve(root, name)))]),
);
json(path.join(output, "source.json"), {
  ...identity,
  harnessSha256,
  boundarySha256: hash(boundary),
  bundleSha256: hash(fs.readFileSync(bundle)),
  inputs,
});
process.env.OPENCLAW_STATE_DIR = path.join(output, "state");
const { quiesceLocalWorkspace } = (await import(pathToFileURL(bundle).href)) as {
  quiesceLocalWorkspace: (params: {
    workspaceDir: string;
    retained: { name: string; id: string }[];
    persist: (held: { name: string; id: string }[]) => void;
    assertCurrent: () => void;
  }) => Promise<{ markPhase: (phase: string) => void; resume: () => Promise<void> }>;
};

type Entry = {
  containerName: string;
  workspaceDir: string;
  backendId: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
};
type Event = { name: string; at: number; duration: number; paused: string[] };
const workspace = "/synthetic/selected";
const ids: readonly [string, string, string] = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const names: readonly [string, string, string] = ["container", "browser", "stream-child"];
const bodyPhases = [
  ["operation", 1900],
  ["recovery", 100],
  ["capture", 1400],
  ["scan", 1600],
  ["staging", 300],
  ["materialization", 1200],
  ["preflight", 100],
  ["patch", 100],
  ["apply", 2200],
  ["acceptance", 100],
  ["verification", 1100],
  ["cleanup", 100],
] as const;
class Fixture {
  now = 0;
  resuming = false;
  recording = false;
  events: Event[] = [];
  messages: string[] = [];
  counts: Record<string, number> = {};
  logBytes = 0;
  paused = new Map<string, number>();
  freezes: { id: string; start: number; end: number }[] = [];
  held: { name: string; id: string }[] = [];
  containers = new Map<string, Entry[]>();
  browsers = new Map<string, Entry[]>();
  streams: unknown[] = [];
  readonly writers: number;
  constructor(writers: number) {
    this.writers = writers;
    for (let index = 0; index < 10_000; index++) {
      const other = "/synthetic/unrelated/" + index;
      this.containers.set(other, [this.entry("unrelated-" + index, other)]);
    }
    this.containers.set(workspace, [this.entry(names[0], workspace)]);
    if (writers === 3) {
      this.browsers.set(workspace, [this.entry(names[1], workspace)]);
    }
    for (let index = 0; index < 8; index++) {
      this.streams.push(this.stream("other-" + index, "/synthetic/other", ids[0]));
    }
    if (writers === 3) {
      this.streams.push(this.stream("child", workspace, ids[2]));
    }
  }
  entry(containerName: string, workspaceDir: string): Entry {
    return {
      containerName,
      workspaceDir,
      backendId: "docker",
      sessionKey: containerName,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "synthetic",
    };
  }
  stream(attemptId: string, workspaceDir: string, containerId: string) {
    return {
      attemptId,
      ownerKey: attemptId,
      phase: "running",
      workspaceBinding: { workspaceDir },
      receipt: { containerId },
      backendTarget: {},
    };
  }
  advance(name: string, duration: number) {
    if (this.recording) {
      this.counts[name] = (this.counts[name] ?? 0) + 1;
    }
    if (this.recording) {
      this.events.push({ name, at: this.now, duration, paused: [...this.paused.keys()] });
    }
    this.now += duration;
  }
  authority() {
    this.advance("authority", this.resuming ? 1100 : 10);
  }
  command(args: string[]) {
    const target = args.at(-1)!;
    const ordinal = ids.includes(target) ? ids.indexOf(target) : names.indexOf(target);
    const id = ids[ordinal];
    assert(id !== undefined && ordinal < this.writers);
    const command = args[0];
    if (command === "inspect") {
      if (args.includes("{{.State.Paused}}")) {
        this.advance("inspect.resume", 1300);
        return { code: 0, stdout: String(this.paused.has(id)), stderr: "" };
      }
      this.advance("inspect.initial", ordinal === 1 ? 5000 : 80);
      return { code: 0, stdout: id + " true " + String(this.paused.has(id)), stderr: "" };
    }
    if (command === "pause") {
      this.advance("pause", 40);
      assert(!this.paused.has(id));
      this.paused.set(id, this.now);
    } else if (command === "unpause") {
      this.advance("unpause", 1200);
      const start = this.paused.get(id);
      assert(start !== undefined);
      if (this.recording) {
        this.freezes.push({ id, start, end: this.now });
      }
      this.paused.delete(id);
    } else {
      throw new Error("Unexpected engine command " + command);
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  persist(held: { name: string; id: string }[]) {
    this.advance("persist", 15);
    this.held = held.slice();
  }
  log(message: string) {
    this.advance("log", 0);
    this.logBytes += Buffer.byteLength(message);
    if (this.recording) {
      this.messages.push(message);
    }
  }
  reset(recording: boolean) {
    assert.equal(this.paused.size, 0);
    assert.equal(this.held.length, 0);
    this.now = 0;
    this.resuming = false;
    this.recording = recording;
    this.events = [];
    this.messages = [];
    this.counts = {};
    this.freezes = [];
    this.logBytes = 0;
  }
}
const slot = Symbol.for("openclaw.quiescence.measure");
const globals = globalThis as unknown as Record<symbol, Fixture>;
const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
Object.defineProperty(performance, "now", {
  configurable: true,
  value: () => globals[slot]?.now ?? 0,
});
const run = async (fixture: Fixture, retained = false) => {
  if (retained) {
    fixture.paused.set(ids[0], fixture.now);
  }
  const custody = await quiesceLocalWorkspace({
    workspaceDir: workspace,
    retained: retained ? [{ name: names[0], id: ids[0] }] : [],
    persist: (held) => fixture.persist(held),
    assertCurrent() {},
  });
  for (const [phase, ms] of bodyPhases) {
    custody.markPhase(phase);
    fixture.advance("body." + phase, ms);
  }
  fixture.resuming = true;
  await custody.resume();
  assert.equal(fixture.paused.size, 0);
  assert.equal(fixture.held.length, 0);
};
const freeDisk = () => {
  const disk = fs.statfsSync(output);
  return disk.bavail * disk.bsize;
};
const reports: unknown[] = [];
try {
  for (const writers of [1, 3]) {
    const fixture = new Fixture(writers);
    globals[slot] = fixture;
    fixture.reset(true);
    await run(fixture);
    const verification = {
      writers,
      logicalOwnerMs: fixture.now,
      events: fixture.events,
      messages: fixture.messages,
      freezes: fixture.freezes,
      counts: fixture.counts,
    };
    assert.equal(verification.freezes.length, writers);
    assert.equal(
      verification.messages.filter((message) => message.startsWith("Local workspace unpause:"))
        .length,
      writers,
    );
    const unpauseMessages = verification.messages.filter((message) =>
      message.startsWith("Local workspace unpause:"),
    );
    const hasBreakdown = unpauseMessages[0]!.includes(" phaseDurationsMs=");
    for (const message of unpauseMessages) {
      assert(message.includes("outcome=resumed"));
      if (!hasBreakdown) {
        continue;
      }
      const encodedPhases = message.match(/phaseDurationsMs=(\{[^}]*\})/)?.[1];
      assert(encodedPhases);
      const phases: Record<string, number> = JSON.parse(encodedPhases);
      const allowed = new Set([
        "pause",
        "resume",
        "resumeInspect",
        "resumeAuthority",
        "unpause",
        ...bodyPhases.map(([phase]) => phase),
      ]);
      for (const [phase, ms] of Object.entries(phases)) {
        assert(allowed.has(phase));
        assert(Number.isInteger(ms) && ms >= 1000);
      }
      for (const [phase, ms] of bodyPhases) {
        assert.equal(phases[phase], ms >= 1000 ? ms : undefined);
      }
      assert.equal(phases.resumeInspect, 1300);
      assert.equal(phases.resumeAuthority, 1100);
      assert.equal(phases.unpause, 1200);
    }
    for (const command of ["inspect.initial", "inspect.resume", "pause", "unpause"]) {
      assert.equal(verification.counts[command], writers);
    }
    assert.equal(verification.counts.authority, writers * 4);
    assert.equal(verification.counts.persist, writers * 2);
    assert.equal(verification.counts.target, writers * 2);
    if (hasBreakdown) {
      const firstPause = verification.events.findIndex((event) => event.name === "pause");
      const before = verification.events.slice(0, firstPause);
      assert.equal(before.filter((event) => event.name === "inspect.initial").length, writers);
      assert.equal(before.filter((event) => event.name === "persist").length, writers);
      assert(before.every((event) => event.paused.length === 0));
    }
    json(path.join(output, `verification-${writers}.json`), verification);
    fixture.reset(true);
    await run(fixture, true);
    const recoveredLog = fixture.messages.at(-1)!;
    assert(recoveredLog.includes("durationScope=observed"));
    assert.equal(Number(recoveredLog.match(/durationMs=(\d+)/)![1]), writers === 1 ? 13840 : 26480);
    json(path.join(output, `recovery-${writers}.json`), {
      messages: fixture.messages,
      events: fixture.events,
      freezes: fixture.freezes,
      counts: fixture.counts,
    });
    for (let index = 0; index < warmup; index++) {
      fixture.reset(false);
      await run(fixture);
    }
    const inspector = values.allocation ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.enable");
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const beforeLoad = os.loadavg();
    const beforeHeap = process.memoryUsage();
    const cpu = process.cpuUsage();
    const thread = process.threadCpuUsage();
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index++) {
      fixture.reset(false);
      await run(fixture);
    }
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const mainCpu = process.threadCpuUsage(thread);
    const processCpu = process.cpuUsage(cpu);
    const afterHeap = process.memoryUsage();
    let sampledAllocationBytes: number | undefined;
    if (inspector) {
      const allocation = await inspector.post("HeapProfiler.stopSampling");
      const cpuProfile = await inspector.post("Profiler.stop");
      json(path.join(output, `allocation-${writers}.heapprofile`), allocation.profile);
      json(path.join(output, `cpu-${writers}.cpuprofile`), cpuProfile.profile);
      const sum = (node: typeof allocation.profile.head): number =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      sampledAllocationBytes = sum(allocation.profile.head);
      inspector.disconnect();
    }
    reports.push({
      writers,
      iterations,
      warmup,
      wallMs,
      processCpu,
      mainCpu,
      sampledAllocationBytes,
      beforeHeap,
      afterHeap,
      beforeLoad,
      afterLoad: os.loadavg(),
      freeBytes: freeDisk(),
      countsPerCycle: verification.counts,
    });
  }
} finally {
  if (originalNow) {
    Object.defineProperty(performance, "now", originalNow);
  } else {
    Reflect.deleteProperty(performance, "now");
  }
  delete globals[slot];
}
assert.equal(hash(fs.readFileSync(path.join(snapshot, "owner.ts"))), identity.ownerSha256);
for (const [name, digest] of Object.entries(inputs)) {
  assert.equal(hash(fs.readFileSync(path.resolve(root, name))), digest);
}
json(path.join(output, "report.json"), {
  source: identity,
  runtime: {
    executable: process.execPath,
    node: process.version,
    bun: Reflect.get(process.versions, "bun"),
    platform: process.platform,
    cpus: os.cpus().length,
  },
  allocation: values.allocation,
  qualification:
    "Real quiescence owner; synthetic registry/custody/engine and logical time. CPU/wall are real; allocation is main JS isolate only. No native engine/DB/large-tree performance claim.",
  reports,
});
console.log(JSON.stringify({ output, verified: true }));
