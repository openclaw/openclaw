// Node 26 --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-library-filesystem-measure.mjs
// --baseline <saved selection.ts, bundle.ts, resources.ts> [--worker <compiled discovery.worker.js>]
// Six synthetic three-file pins; six delivery turns and 33 cache-churning selections.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics, startHeapProfile, startCpuProfile } from "node:v8";
import workerThreads from "node:worker_threads";
import { transformSync } from "esbuild";
import { readGlobalSingleton } from "../../src/shared/global-singleton.ts";
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    profile: { type: "string" },
    worker: { type: "string" },
    "counts-only": { type: "boolean" },
  },
});
assert(values.baseline, "Supply --baseline <saved source directory>");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Use Node 26");
const baselineFiles = new Map(
  ["selection", "bundle", "resources"].map((name) => [
    name,
    fs.readFileSync(path.join(values.baseline, name + ".ts"), "utf8"),
  ]),
);
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("?libraryMeasure=baseline")) {
      const name = path.basename(new URL(url).pathname, ".ts");
      let source = baselineFiles.get(name);
      assert(source);
      source = source
        .replaceAll('"./bundle.js"', '"./bundle.js?libraryMeasure=baseline"')
        .replaceAll('"../library/bundle.js"', '"../library/bundle.js?libraryMeasure=baseline"')
        .replaceAll(
          '"../library/selection.js"',
          '"../library/selection.js?libraryMeasure=baseline"',
        );
      return {
        format: "module",
        source: transformSync(source, { loader: "ts", format: "esm" }).code,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const Worker = workerThreads.Worker;
const workers = new Set();
let compiledDiscoveryWorkers = 0;
workerThreads.Worker = class extends Worker {
  constructor(filename, options) {
    const built = values.worker && String(filename).endsWith("/discovery.worker.ts");
    super(
      built ? pathToFileURL(path.resolve(values.worker)) : filename,
      built ? { ...options, execArgv: [] } : options,
    );
    if (built) {
      compiledDiscoveryWorkers++;
    }
    workers.add(this);
    this.once("exit", () => workers.delete(this));
  }
};
syncBuiltinESMExports();
const diagnosticsLifetime = setInterval(() => {}, 1000);
const workerMetrics = async () => {
  const tracked = readGlobalSingleton(Symbol.for("openclaw.workerCpuSources"));
  const metrics = await Promise.all(
    [...(tracked?.workers.keys() ?? workers)].map(async (worker) => ({
      heap: await worker.getHeapStatistics(),
      cpu: await worker.cpuUsage(),
    })),
  );
  return metrics.reduce(
    (sum, value) => ({
      bytes: sum.bytes + value.heap.total_allocated_bytes,
      cpu: sum.cpu + value.cpu.user + value.cpu.system,
    }),
    { bytes: 0, cpu: 0 },
  );
};
console.log(JSON.stringify({ phase: "environment", runtime: process.version, load: loadavg() }));
const directory = await fsp.mkdtemp(path.resolve(".local/synthetic-library-fs-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_BUNDLED_SKILLS_DIR = path.join(directory, "empty-bundled");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.ts");
const { saveSkillLibrary } = await import("../../src/skills/library/service.ts");
const { prepareSkillLibrarySelection: baselineSelection } =
  await import("../../src/skills/library/selection.ts?libraryMeasure=baseline");
const { prepareSkillResourceDelivery: baselineDelivery } =
  await import("../../src/skills/runtime/resources.ts?libraryMeasure=baseline");
const { prepareSkillLibrarySelection } = await import("../../src/skills/library/selection.ts");
const { prepareSkillResourceDelivery } = await import("../../src/skills/runtime/resources.ts");
const { buildSkillSnapshot } = await import("../../src/skills/loading/workspace-skill-prompt.ts");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.ts");
const options = { env: { OPENCLAW_STATE_DIR: directory } };
const profile = ensureProfileForEmail("synthetic-library@example.test", options);
const authority = {
  profileId: profile.id,
  scopes: ["operator.read", "operator.write"],
  getConfig: () => ({ plugins: { enabled: false } }),
  assertCurrent() {},
};
const pins = [];
let restore = () => {};
try {
  for (let i = 0; i < 6; i++) {
    const saved = await saveSkillLibrary(
      authority,
      {
        slug: `guide-${i}`,
        content: `---\nname: guide-${i}\ndescription: Synthetic guide\n---\nRead references/help.md.\n`,
        expectedRevision: null,
        files: [
          { path: "references/help.md", content: "Synthetic companion" },
          { path: "scripts/example.sh", content: "echo synthetic", executable: true },
        ],
      },
      options,
    );
    const { skillId, revision, name, ownerProfileId } = saved.entry;
    pins.push({ skillId, revision, name, ownerProfileId });
  }
  if (!values["counts-only"]) {
    for (let sample = 0; sample < 5; sample++) {
      const selection = pins.map((pin) => ({ ...pin, name: `${pin.name}-cold-${sample}` }));
      for (const [label, prepare] of [
        ["baseline", baselineSelection],
        ["candidate", prepareSkillLibrarySelection],
      ]) {
        const beforeWorker = await workerMetrics();
        const bytes = getHeapStatistics().total_allocated_bytes;
        const thread = process.threadCpuUsage();
        const cpu = process.cpuUsage();
        const start = performance.now();
        assert.equal((await prepare(selection, options, () => {})).length, 6);
        const ms = performance.now() - start;
        const usedThread = process.threadCpuUsage(thread);
        const usedCpu = process.cpuUsage(cpu);
        const mainAllocatedBytes = getHeapStatistics().total_allocated_bytes - bytes;
        const afterWorker = await workerMetrics();
        console.log(
          JSON.stringify({
            phase: "cold-selection",
            sample,
            label,
            ms,
            mainCpuUs: usedThread.user + usedThread.system,
            processCpuUs: usedCpu.user + usedCpu.system,
            mainAllocatedBytes,
            workerAllocatedBytes: afterWorker.bytes - beforeWorker.bytes,
            workerCpuUs: afterWorker.cpu - beforeWorker.cpu,
          }),
        );
      }
    }
  }
  const prefix = path.join(directory, "skill-library") + path.sep;
  const originals = new Map();
  const openFds = new Set();
  let counts = {};
  let owners = {};
  let active = false;
  const relevant = (arg) =>
    typeof arg === "number" ? openFds.has(arg) : typeof arg === "string" && arg.startsWith(prefix);
  const wrap = (name, original) =>
    function (...args) {
      const counted = active && relevant(args[0]);
      if (counted) {
        counts[name] = (counts[name] ?? 0) + 1;
        if (!owners[name]) {
          owners[name] = new Error().stack
            .split("\n")
            .filter((line) => line.includes("/src/skills/") || line.includes("/fs-safe/"))
            .slice(0, 4)
            .map((line) => line.replaceAll(process.cwd() + "/", ""));
        }
      }
      const result = Reflect.apply(original, this, args);
      if (name === "openSync" && relevant(args[0])) {
        openFds.add(result);
      }
      if (name === "closeSync") {
        openFds.delete(args[0]);
      }
      return result;
    };
  for (const name of [
    "accessSync",
    "existsSync",
    "statSync",
    "lstatSync",
    "fstatSync",
    "openSync",
    "readSync",
    "readFileSync",
    "readdirSync",
    "closeSync",
  ]) {
    originals.set(name, fs[name]);
    fs[name] = wrap(name, fs[name]);
  }
  const realpath = fs.realpathSync;
  fs.realpathSync = Object.assign(wrap("realpathSync", realpath), {
    native: wrap("realpathSync.native", realpath.native),
  });
  syncBuiltinESMExports();
  restore = () => {
    for (const [name, original] of originals) {
      fs[name] = original;
    }
    fs.realpathSync = realpath;
    syncBuiltinESMExports();
  };
  const measure = async (phase, operation) => {
    counts = {};
    owners = {};
    active = true;
    try {
      await operation();
    } finally {
      active = false;
    }
    console.log(JSON.stringify({ phase, counts, owners }));
  };
  const selections = Array.from({ length: 33 }, (_, i) =>
    pins.filter((pin, bit) => ((i + 1) >> bit) & 1),
  );
  const entries = await prepareSkillLibrarySelection(pins, options, () => {});
  const snapshot = {
    ...(await buildSkillSnapshot(directory, { entries })),
    librarySelections: pins,
  };
  const variants = {
    baseline: { selection: baselineSelection, delivery: baselineDelivery },
    candidate: { selection: prepareSkillLibrarySelection, delivery: prepareSkillResourceDelivery },
  };
  const operate = async (label, kind) => {
    const variant = variants[label];
    if (kind === "selection") {
      for (const selection of selections) {
        assert.equal(
          (await variant.selection(selection, options, () => {})).length,
          selection.length,
        );
      }
    } else {
      for (let turn = 0; turn < 6; turn++) {
        const result = await variant.delivery(snapshot, () => {}, [], directory);
        assert.equal(result.skills.length, 6);
        assert.equal(
          result.skills.reduce((sum, skill) => sum + skill.files.length, 0),
          18,
        );
      }
    }
  };
  for (const kind of ["selection", "delivery"]) {
    for (const label of ["baseline", "candidate"]) {
      await operate(label, kind);
    }
    for (const label of ["baseline", "baseline", "candidate"]) {
      await measure(`${kind}-${label}`, () => operate(label, kind));
    }
  }
  restore();
  restore = () => {};
  if (values.worker) {
    assert(compiledDiscoveryWorkers > 0, "Compiled discovery worker was not used");
  }
  console.log(
    JSON.stringify({
      phase: "worker-scope",
      compiledDiscoveryWorkers,
      workers: [
        ...readGlobalSingleton(Symbol.for("openclaw.workerCpuSources")).workers.values(),
      ].map((source) => source.script),
    }),
  );
  if (!values["counts-only"]) {
    for (const kind of ["selection", "delivery"]) {
      for (const [index, label] of [
        "baseline",
        "baseline",
        ...Array.from({ length: 5 }, () => ["baseline", "candidate"]).flat(),
      ].entries()) {
        global.gc?.();
        const beforeWorker = await workerMetrics();
        const beforeBytes = getHeapStatistics().total_allocated_bytes;
        const thread = process.threadCpuUsage();
        const processCpu = process.cpuUsage();
        const start = performance.now();
        await operate(label, kind);
        const ms = performance.now() - start;
        const usedThread = process.threadCpuUsage(thread);
        const usedProcess = process.cpuUsage(processCpu);
        const mainAllocatedBytes = getHeapStatistics().total_allocated_bytes - beforeBytes;
        const afterWorker = await workerMetrics();
        console.log(
          JSON.stringify({
            phase: "warm",
            kind,
            index,
            label,
            ms,
            mainCpuUs: usedThread.user + usedThread.system,
            processCpuUs: usedProcess.user + usedProcess.system,
            mainAllocatedBytes,
            workerAllocatedBytes: afterWorker.bytes - beforeWorker.bytes,
            workerCpuUs: afterWorker.cpu - beforeWorker.cpu,
            load: loadavg(),
          }),
        );
      }
    }
  }
  if (values.profile) {
    await fsp.mkdir(values.profile, { recursive: true });
    const tracked = readGlobalSingleton(Symbol.for("openclaw.workerCpuSources"));
    const discovery = [...tracked.workers.entries()].find(
      ([, source]) => source.script === "discovery.worker.js",
    )?.[0];
    assert(discovery?.startHeapProfile, "Discovery worker profiler is unavailable");
    const heapOptions = {
      sampleInterval: 4096,
      stackDepth: 32,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    };
    for (const kind of ["selection", "delivery"]) {
      for (const label of ["baseline", "candidate"]) {
        const workerHeap = await discovery.startHeapProfile(heapOptions);
        const workerCpu = await discovery.startCpuProfile({ sampleInterval: 1 });
        const mainHeap = startHeapProfile(heapOptions);
        const mainCpu = startCpuProfile({ sampleInterval: 1 });
        for (let sample = 0; sample < 5; sample++) {
          await operate(label, kind);
        }
        const mainHeapData = mainHeap.stop();
        const mainCpuData = mainCpu.stop();
        const workerHeapData = await workerHeap.stop();
        const workerCpuData = await workerCpu.stop();
        for (const [suffix, data] of [
          ["main.heapprofile", mainHeapData],
          ["main.cpuprofile", mainCpuData],
          ["worker.heapprofile", workerHeapData],
          ["worker.cpuprofile", workerCpuData],
        ]) {
          await fsp.writeFile(path.join(values.profile, `${kind}-${label}-${suffix}`), data);
        }
      }
    }
  }
} finally {
  restore();
  await drainGlobalSingletonLifecycleState();
  workerThreads.Worker = Worker;
  syncBuiltinESMExports();
  clearInterval(diagnosticsLifetime);
  await fsp.rm(directory, { recursive: true, force: true });
}
