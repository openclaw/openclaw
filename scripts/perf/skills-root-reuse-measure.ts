/**
 * Synthetic async skill preparation: project / no project / project, three shadow groups.
 * Prepare once, then run >=5 AB/BA timing pairs, A/A controls, and separate allocation pairs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skills-root-reuse-measure.ts --prepare
 * Before editing, save both workspace-skill-loader.ts and skill-precedence.ts beside their
 * sources as .baseline.ts; redirect the saved loader import to ./skill-precedence.baseline.js.
 * Add --owner src/skills/loading/workspace-skill-loader.baseline.ts for that saved baseline.
 * Remove the two saved modules after the comparison.
 * Acceptance: equal selections; no warm discovery tasks; three cold warnings and zero warm
 * warnings after the fix; no material CPU/allocation regression. --count-fs measures warm
 * fs calls separately from timing/allocation passes. This is owner proof, not
 * Gateway latency. --cold counts JS synchronous fs API calls on the real source reader;
 * native/internal syscalls and worker startup are not included in those counts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import inspector from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/skills/loading/workspace-skill-loader.ts" },
    fixture: { type: "string", default: ".local/2036/fixture" },
    iterations: { type: "string", default: "500" },
    prepare: { type: "boolean" },
    allocations: { type: "boolean" },
    cold: { type: "boolean" },
    "count-fs": { type: "boolean" },
  },
});
function countFileSystemCalls() {
  const counts: Record<string, number> = {};
  const methods = [
    "existsSync",
    "accessSync",
    "statSync",
    "lstatSync",
    "realpathSync",
    "opendirSync",
    "readdirSync",
    "readFileSync",
    "openSync",
    "readSync",
    "fstatSync",
    "closeSync",
  ] as const;
  const restore = methods.map((method) => {
    const original = fs[method];
    const wrapper = Object.assign((...args: unknown[]) => {
      counts[method] = (counts[method] ?? 0) + 1;
      return Reflect.apply(original, fs, args);
    }, original);
    if (method === "realpathSync") {
      const native = fs.realpathSync.native;
      Object.defineProperty(wrapper, "native", {
        value: (...args: unknown[]) => {
          counts["realpathSync.native"] = (counts["realpathSync.native"] ?? 0) + 1;
          return Reflect.apply(native, fs, args);
        },
      });
    }
    Object.defineProperty(fs, method, { value: wrapper, configurable: true, writable: true });
    return () =>
      Object.defineProperty(fs, method, { value: original, configurable: true, writable: true });
  });
  syncBuiltinESMExports();
  return {
    counts,
    restore: () => {
      restore.forEach((restoreMethod) => restoreMethod());
      syncBuiltinESMExports();
    },
  };
}
const fixture = path.resolve(values.fixture);
const home = path.join(fixture, "home");
const workspace = path.join(home, ".openclaw/workspace");
const project = path.join(home, ".openclaw/projects/project");
const bundled = path.join(fixture, "release/skills");
const roots = [path.join(home, ".agents/skills"), bundled, path.join(workspace, "skills")];
const skillCount = 96;
const fillerCount = 62_000 - skillCount * 2;
const fillerBytes = 19_000;
if (values.prepare) {
  for (let index = 0; index < skillCount; index++) {
    const name = `guide-${index}`;
    for (const [root, description] of [
      [roots[index % roots.length]!, "Agent instructions"],
      [path.join(project, ".agents/skills"), "Project instructions"],
    ]) {
      const directory = path.join(root!, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nSynthetic instructions.\n`,
      );
    }
  }
  const payload = Buffer.alloc(fillerBytes, 120);
  for (let index = 0; index < fillerCount; index++) {
    const directory = path.join(project, "src", String(Math.floor(index / 500)));
    if (index % 500 === 0) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(directory, `file-${index}.txt`), payload);
  }
  console.log(JSON.stringify({ files: 62_000, fillerBytes: fillerCount * fillerBytes, fixture }));
  process.exit(0);
}
assert(global.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
for (const [key, value] of Object.entries({
  HOME: home,
  USERPROFILE: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
  OPENCLAW_BUNDLED_SKILLS_DIR: bundled,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, "plugins"),
})) {
  process.env[key] = value;
}
const { applyLoggingConfig } = await import("../../src/logging/logger.js");
const { loggingState } = await import("../../src/logging/state.js");
applyLoggingConfig({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
let warnings = 0;
const capture = (...args: unknown[]) => {
  if (args.some((value) => String(value).includes("Skill precedence collisions resolved"))) {
    warnings++;
  }
};
loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
const { WorkerTaskPool } = await import("../../src/infra/worker-task-pool.js");
const taskObserver = mock.method(WorkerTaskPool.prototype, "run");
function countTasks() {
  const tasks: Record<string, number> = {};
  for (const {
    arguments: [input],
  } of taskObserver.mock.calls) {
    if (input && typeof input === "object" && "kind" in input && typeof input.kind === "string") {
      tasks[input.kind] = (tasks[input.kind] ?? 0) + 1;
    }
  }
  return tasks;
}
const { closeSkillsWatchers, prepareSkillSourcePlan } =
  await import("../../src/skills/runtime/refresh.js");
const { prepareWorkspaceSkillEntries } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/skills/loading/workspace-skill-loader.js");
const options = {
  watch: false,
  config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
};
const prepare = (executionWorkspaceDir?: string) =>
  prepareWorkspaceSkillEntries(workspace, { ...options, executionWorkspaceDir });
const digest = createHash("sha256");
const loadStart = loadavg();
try {
  if (values.cold) {
    const { readWorkspaceSkillSources } =
      await import("../../src/skills/loading/workspace-skill-source-reader.js");
    const { resolveSkillDiscoveryLimits } =
      await import("../../src/skills/loading/skill-root-discovery.js");
    const { plan } = await prepareSkillSourcePlan(workspace, options);
    const observation = countFileSystemCalls();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const source = readWorkspaceSkillSources({
      sourcePlan: plan,
      executionWorkspaceDir: project,
      limits: resolveSkillDiscoveryLimits(),
      additionalBins: [],
    });
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    observation.restore();
    assert.equal(source.entries.length, skillCount);
    assert.equal(source.executionEntries.length, skillCount);
    process.stdout.write(
      `${JSON.stringify({ cold: true, counts: observation.counts, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, loadStart, loadEnd: loadavg() })}\n`,
    );
  } else {
    await prepare(project);
    await prepare();
    const cold = { warnings, tasks: countTasks() };
    for (let index = 0; index < 10; index++) {
      await prepare(project);
      await prepare();
    }
    warnings = 0;
    taskObserver.mock.resetCalls();
    global.gc();
    await yieldTurn();
    const profiler = values.allocations ? new inspector.Session() : undefined;
    profiler?.connect();
    if (profiler) {
      await profiler.post("HeapProfiler.startSampling", {
        samplingInterval: 16384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const samples: number[] = [];
    const observation = values["count-fs"] ? countFileSystemCalls() : undefined;
    for (let index = 0; index < iterations; index++) {
      for (const execution of [project, undefined, project]) {
        const callStart = performance.now();
        const result = await prepare(execution);
        samples.push(performance.now() - callStart);
        assert.equal(result.entries.length, skillCount);
        digest.update(
          result.entries
            .map((entry) => `${entry.skill.name}:${entry.skill.description}`)
            .join("\n"),
        );
      }
    }
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    observation?.restore();
    let allocatedBytes: number | undefined;
    if (profiler) {
      const { profile } = await profiler.post("HeapProfiler.stopSampling");
      const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      allocatedBytes = sum(profile.head);
      profiler.disconnect();
    }
    const orderedSamples = samples.toSorted((left, right) => left - right);
    const latencyMs = {
      min: orderedSamples[0],
      median: orderedSamples[Math.floor(orderedSamples.length / 2)],
      p95: orderedSamples[Math.floor(orderedSamples.length * 0.95)],
      max: orderedSamples.at(-1),
    };
    process.stdout.write(
      `${JSON.stringify({ fsCalls: observation?.counts, latencyMs, owner: values.owner, iterations, calls: iterations * 3, cold, tasks: countTasks(), warnings, digest: digest.digest("hex"), elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, allocatedBytes, loadStart, loadEnd: loadavg() })}\n`,
    );
  }
} finally {
  taskObserver.mock.restore();
  await closeSkillsWatchers(true);
}
