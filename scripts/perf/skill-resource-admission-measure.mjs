// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-resource-admission-measure.mjs
// --baseline <saved-installed-skill-runtime.ts> [--worker <built-discovery-worker.js>]
// Real catalog preparation, 40 synthetic skills, A/A then five A/B pairs.
// Accept zero main-thread sync lookups with unchanged directory-bound readers.
// This measures admission; the Gateway campaign measures request latency separately.
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import workerThreads from "node:worker_threads";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    worker: { type: "string" },
    profile: { type: "string" },
    iterations: { type: "string", default: "200" },
  },
});
assert(global.gc && values.baseline, "Use --expose-gc and --baseline <source>");
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Use Node 26 allocation counters",
);
console.log(
  JSON.stringify({
    phase: "environment",
    runtime: process.version,
    execPath: process.execPath,
    load: loadavg(),
  }),
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const baselineSource = fs.readFileSync(values.baseline, "utf8");
const Worker = workerThreads.Worker;
const workers = new Set();
workerThreads.Worker = class extends Worker {
  constructor(filename, options) {
    const built = values.worker && String(filename).endsWith("/discovery.worker.ts");
    super(
      built ? pathToFileURL(path.resolve(values.worker)) : filename,
      built ? { ...options, execArgv: [] } : options,
    );
    workers.add(this);
    this.once("exit", () => workers.delete(this));
  }
};
syncBuiltinESMExports();
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/installed-skill-runtime.ts?resourceMeasure=baseline")) {
      return { format: "module", source: stripTypeScriptTypes(baselineSource), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const directory = path.resolve(".local/skill-resource-admission");
fs.mkdirSync(directory, { recursive: true });
const workspaceDir = fs.mkdtempSync(path.join(directory, "synthetic-"));
process.env.OPENCLAW_STATE_DIR = path.join(workspaceDir, "state");
const { createSyntheticSourceInfo } = await import("../../src/skills/loading/skill-contract.ts");
const { prepareInstalledSkillCatalog: baseline } =
  await import("../../src/agents/installed-skill-runtime.ts?resourceMeasure=baseline");
const { prepareInstalledSkillCatalog: candidate } =
  await import("../../src/agents/installed-skill-runtime.ts");
const { closeSkillsWatchers } = await import("../../src/skills/runtime/refresh.ts");
const { buildSkillSnapshot } = await import("../../src/skills/loading/workspace-skill-prompt.ts");
const { WorkerTaskPool } = await import("../../src/infra/worker-task-pool.ts");
const skills = Array.from({ length: 40 }, (_, index) => {
  const baseDir = path.join(workspaceDir, `guide-${index}`);
  fs.mkdirSync(baseDir);
  const filePath = path.join(baseDir, "SKILL.md");
  fs.writeFileSync(filePath, "Synthetic instructions.");
  return {
    name: `guide-${index}`,
    description: "Synthetic instructions",
    filePath,
    baseDir,
    source: "bundled",
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "bundled" }),
    disableModelInvocation: false,
    readContent: "Synthetic instructions.",
  };
});
const snapshot = await buildSkillSnapshot(workspaceDir, {
  entries: skills.map((skill) => ({ skill, frontmatter: {} })),
});
const prepare = async (fn) => {
  const catalog = fn({ snapshot, workspaceDir });
  assert.equal(catalog.length, 40);
  const roots = await Promise.all(catalog.map((skill) => skill.resourceRoot));
  assert(roots.every((root) => typeof root?.read === "function"));
};
const workerAllocated = async () =>
  (
    await Promise.all(
      [...workers].map(async (worker) => {
        const bytes = (await worker.getHeapStatistics()).total_allocated_bytes;
        assert(Number.isFinite(bytes), "Worker allocation counter is unavailable");
        return bytes;
      }),
    )
  ).reduce((sum, bytes) => sum + bytes, 0);
const workerCpu = async () =>
  (await Promise.all([...workers].map((worker) => worker.cpuUsage()))).reduce(
    (sum, cpu) => sum + cpu.user + cpu.system,
    0,
  );
// The runtime unrefs idle workers; diagnostic promises alone do not keep Node alive.
const diagnosticsLifetime = setInterval(() => {}, 1_000);
try {
  for (let index = 0; index < 5; index++) {
    for (const [label, fn] of [
      ["baseline", baseline],
      ["candidate", candidate],
    ]) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      await prepare(fn);
      const elapsed = performance.now() - start;
      const used = process.cpuUsage(cpu);
      console.log(
        JSON.stringify({
          phase: "owner-cold",
          index,
          label,
          ms: elapsed,
          processUs: used.user + used.system,
        }),
      );
      await closeSkillsWatchers();
    }
  }
  for (const fn of [baseline, candidate]) {
    for (let index = 0; index < 20; index++) {
      await prepare(fn);
    }
  }
  const stat = fs.statSync;
  const realpath = fs.realpathSync.native;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the live pool receiver; finally restores this exact method.
  const run = WorkerTaskPool.prototype.run;
  let stats = 0;
  let realpaths = 0;
  let workerTasks = 0;
  WorkerTaskPool.prototype.run = function (...args) {
    workerTasks++;
    return Reflect.apply(run, this, args);
  };
  fs.statSync = function (...args) {
    stats++;
    return Reflect.apply(stat, this, args);
  };
  fs.realpathSync.native = function (...args) {
    realpaths++;
    return Reflect.apply(realpath, this, args);
  };
  syncBuiltinESMExports();
  try {
    for (const [label, fn] of [
      ["baseline", baseline],
      ["candidate", candidate],
    ]) {
      stats = 0;
      realpaths = 0;
      workerTasks = 0;
      for (let turn = 0; turn < 6; turn++) {
        await prepare(fn);
      }
      console.log(
        JSON.stringify({
          phase: "counts",
          label,
          turns: 6,
          skills: 40,
          stats,
          realpaths,
          workerTasks,
        }),
      );
    }
  } finally {
    fs.statSync = stat;
    fs.realpathSync.native = realpath;
    WorkerTaskPool.prototype.run = run;
    syncBuiltinESMExports();
  }
  for (const [index, label] of [
    "baseline",
    "baseline",
    ...Array.from({ length: 5 }, () => ["baseline", "candidate"]).flat(),
  ].entries()) {
    global.gc();
    const workerBytes = await workerAllocated();
    const workerCpuStart = await workerCpu();
    const mainBytes = getHeapStatistics().total_allocated_bytes;
    const thread = process.threadCpuUsage();
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      await prepare(label === "baseline" ? baseline : candidate);
    }
    const elapsedMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(thread);
    const processCpu = process.cpuUsage(cpu);
    const mainAllocatedBytes = (getHeapStatistics().total_allocated_bytes - mainBytes) / iterations;
    const workerAllocatedBytes = ((await workerAllocated()) - workerBytes) / iterations;
    const workerCpuUs = ((await workerCpu()) - workerCpuStart) / iterations;
    console.log(
      JSON.stringify({
        phase: "warm",
        index,
        label,
        iterations,
        ms: elapsedMs / iterations,
        threadUs: (threadCpu.user + threadCpu.system) / iterations,
        processUs: (processCpu.user + processCpu.system) / iterations,
        mainAllocatedBytes,
        workerAllocatedBytes,
        workerCpuUs,
        load: loadavg(),
      }),
    );
  }
  if (values.profile) {
    fs.mkdirSync(values.profile, { recursive: true });
    const profiles = await Promise.all(
      [...workers].map(async (worker) => ({
        threadId: worker.threadId,
        handle: await worker.startCpuProfile({ samplingIntervalMicros: 100 }),
      })),
    );
    for (let iteration = 0; iteration < iterations; iteration++) {
      await prepare(candidate);
    }
    for (const { threadId, handle } of profiles) {
      const profile = await handle.stop();
      fs.writeFileSync(
        path.join(values.profile, `skill-resource-worker-${threadId}.cpuprofile`),
        typeof profile === "string" ? profile : JSON.stringify(profile),
      );
    }
  }
} finally {
  await closeSkillsWatchers();
  workerThreads.Worker = Worker;
  syncBuiltinESMExports();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  clearInterval(diagnosticsLifetime);
}
