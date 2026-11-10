/**
 * --synthetic composes 135 unique bodies from public bundled templates, capped at
 * 2/4/8/12/16 KiB. --collect runs GC after each attempt to model idle collection;
 * its elapsed/CPU include forced GC, while per-search timings exclude it.
 * Compare fresh-run skill searches over 64 bundled skill bodies, 2,000 operations.
 * --source files exercises freshly admitted local files; inline is the default.
 * Save baseline catalog/index/ranking modules beside originals; point the saved
 * catalog at the saved index and that index at the saved ranking module:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/skill-search-copies-measure.ts
 *   --catalog-owner src/agents/installed-skill-catalog.baseline.ts
 * Run five paired repetitions, swapping placement/order. Repeat with --allocations
 * separately: untraced runs own CPU, GC and latency. --iterations changes work count.
 * Acceptance: identical result digest, reduced allocated bytes or CPU, no material
 * adverse CPU/GC change. Report host load and absolute deltas; control adverse GC
 * with matched A/A runs. This is owner proof, not a whole-Gateway measurement.
 * --runtime-owner src/agents/installed-skill-runtime.ts binds fresh session catalogs
 * from the same frozen discovery facts. Pair it with --catalog-owner for baselines.
 * --fresh-publications clones those facts with per-run node paths, retaining the
 * owner's content hash to model host capture and resource-delivery identity loss.
 * --skills 1024 --searches-per-run 3 models a large catalog over repeated searches.
 * --counts uses precise coverage in a separate run; never compare its timings.
 * Acceptance: identical results, no unchanged warm index rebuilds, lower CPU/allocation,
 * and no >20% latency, CPU or allocation regression against interleaved A/A controls.
 * --catalog-pattern 0,0,1,0,0,2,0,0,3,0 interleaves a main catalog with three
 * suffix variants. --warmup 0 --iterations 0 isolates the cold build.
 * --memory-report records V8 main/loader heaps before and after diagnostic-only
 * last-resort collection; --settle-ms sets idle time before those observations.
 * --native-memory adds footprint/smaps output, never complete diagnostic reports.
 * --worktrees 14 creates a tiny owned Git repo and one worktree per commit before
 * measurement. --worktree-change unchanged|body|companion changes only unrelated
 * revision text, one SKILL.md halfway through, or one companion on every commit.
 * Local facts come from the production loader; inline delivery uses the production
 * bundle revision. Runs rotate through those libraries, retaining current locations.
 * Fixture creation/loading and normal Git worktree cleanup are outside timings.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import inspector from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import type { InstalledSkill } from "../../src/agents/installed-skill-catalog.js";
import { prepareSkillBundle } from "../../src/skills/library/bundle.js";
import { loadSingleSkillDirectory } from "../../src/skills/loading/local-loader.js";
import type { Skill } from "../../src/skills/loading/skill-contract.js";

const { values } = parseArgs({
  options: {
    "catalog-owner": { type: "string", default: "src/agents/installed-skill-catalog.ts" },
    "runtime-owner": { type: "string" },
    "fresh-publications": { type: "boolean", default: false },
    iterations: { type: "string", default: "2000" },
    skills: { type: "string" },
    "searches-per-run": { type: "string", default: "1" },
    counts: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    source: { type: "string", default: "inline" },
    synthetic: { type: "boolean", default: false },
    collect: { type: "boolean", default: false },
    warmup: { type: "string", default: "20" },
    "catalog-pattern": { type: "string", default: "0" },
    "settle-ms": { type: "string", default: "0" },
    "memory-report": { type: "boolean", default: false },
    "native-memory": { type: "boolean", default: false },
    "metadata-only": { type: "boolean", default: false },
    worktrees: { type: "string", default: "0" },
    "worktree-change": { type: "string", default: "unchanged" },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(["files", "inline"].includes(values.source));
const iterations = Number(values.iterations);
assert(Number.isInteger(iterations) && iterations >= 0);
const warmup = Number(values.warmup);
const settleMs = Number(values["settle-ms"]);
const catalogPattern = values["catalog-pattern"].split(",").map(Number);
assert(Number.isInteger(warmup) && warmup >= 0);
assert(Number.isInteger(settleMs) && settleMs >= 0);
assert(catalogPattern.every((variant) => Number.isInteger(variant) && variant >= 0));
assert(values["runtime-owner"] || catalogPattern.every((variant) => variant === 0));
const skillCount = Number(values.skills ?? (values.synthetic ? 135 : 64));
const searchesPerRun = Number(values["searches-per-run"]);
const worktreeCount = Number(values.worktrees);
assert(Number.isInteger(skillCount) && skillCount > 0);
assert(Number.isInteger(searchesPerRun) && searchesPerRun > 0);
assert(Number.isInteger(worktreeCount) && worktreeCount >= 0);
assert(["unchanged", "body", "companion"].includes(values["worktree-change"]));
assert(worktreeCount === 0 || values["runtime-owner"], "Worktrees require --runtime-owner");
assert(!values["fresh-publications"] || !worktreeCount);
assert(!(values.counts && values.allocations), "Run counts and allocation sampling separately");
assert(
  !values["fresh-publications"] || (values["runtime-owner"] && values.source === "inline"),
  "Fresh publications require an inline runtime-owner workload",
);
const { searchInstalledSkills } = (await import(
  pathToFileURL(path.resolve(values["catalog-owner"])).href
)) as typeof import("../../src/agents/installed-skill-catalog.js");
const runtime = values["runtime-owner"]
  ? ((await import(
      pathToFileURL(path.resolve(values["runtime-owner"])).href
    )) as typeof import("../../src/agents/installed-skill-runtime.js"))
  : undefined;
const bundledBodies = readdirSync("skills", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join("skills", entry.name, "SKILL.md"))
  .toSorted()
  .flatMap((file) => {
    try {
      return [{ filePath: path.resolve(file), content: readFileSync(file, "utf8") }];
    } catch {
      return [];
    }
  });
const bodies = values.synthetic
  ? Array.from({ length: skillCount }, (_, index) => ({
      filePath: `/synthetic/skills/${index}/SKILL.md`,
      content: (
        `# Synthetic guide ${index}\n` +
        bundledBodies[index % bundledBodies.length]!.content.repeat(
          Math.ceil(16384 / bundledBodies[index % bundledBodies.length]!.content.length),
        )
      ).slice(0, [2048, 4096, 8192, 12288, 16384][index % 5]),
    }))
  : bundledBodies;
assert(!values.synthetic || values.source === "inline" || worktreeCount > 0);
assert(bodies.length > 0);
const templates: InstalledSkill[] = Array.from({ length: skillCount }, (_, index) => ({
  name: `guide-${index}`,
  description: `Synthetic guide ${index} for file search, messages and scheduled tasks`,
  location: `/synthetic/skills/${index}/SKILL.md`,
  source: {
    filePath: bodies[index % bodies.length]!.filePath,
    readContent: values.source === "inline" ? bodies[index % bodies.length]!.content : undefined,
  },
}));
// Discovery interns these immutable facts; session wrappers and admitted readers
// are fresh. Inline node resources avoid unrelated host-path admission work.
const canonicalSkills: Skill[] = templates.map((skill, index) => {
  const filePath =
    values.source === "inline" ? `node://synthetic/${skill.name}/SKILL.md` : skill.source.filePath;
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    filePath,
    baseDir: path.dirname(filePath),
    source: "synthetic",
    sourceInfo: Object.freeze({
      path: filePath,
      source: "synthetic",
      scope: "temporary" as const,
      origin: "top-level" as const,
    }),
    readContent: skill.source.readContent,
    contentHash: createHash("sha256")
      .update(bodies[index % bodies.length]!.content)
      .digest("hex"),
    disableModelInvocation: false,
  });
});

const changedBodyTerm = "fixtureworktreebodyrevision";
function prepareWorktrees() {
  mkdirSync(".local", { recursive: true });
  const directory = mkdtempSync(path.resolve(".local/skill-search-worktrees-"));
  const repository = path.join(directory, "repository");
  mkdirSync(repository);
  const worktrees: string[] = [];
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Synthetic Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        repository,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim();
  };
  const cleanup = () => {
    for (const worktree of worktrees) {
      git("worktree", "remove", worktree);
    }
    rmSync(directory, { recursive: true });
  };
  process.once("exit", cleanup);
  git("init", "--quiet");
  for (const [index, skill] of templates.entries()) {
    const skillDir = path.join(repository, ".agents", "skills", skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${bodies[index % bodies.length]!.content}`,
    );
  }
  const firstSkillDir = path.join(repository, ".agents", "skills", templates[0]!.name);
  writeFileSync(path.join(firstSkillDir, "companion.js"), "export const revision = 0;\n");
  const libraries: Skill[][] = [];
  const commits: string[] = [];
  let fixtureBytes = 0;
  for (let revision = 0; revision < worktreeCount; revision++) {
    const revisionText = `Synthetic repository revision ${revision}\n`;
    writeFileSync(path.join(repository, "revision.txt"), revisionText);
    if (values["worktree-change"] === "body" && revision === Math.ceil(worktreeCount / 2)) {
      const file = path.join(firstSkillDir, "SKILL.md");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("\n---\n", `\n---\n${changedBodyTerm}\n`),
      );
    }
    if (values["worktree-change"] === "companion") {
      writeFileSync(
        path.join(firstSkillDir, "companion.js"),
        `export const revision = ${revision};\n`,
      );
    }
    git("add", "--all");
    git("commit", "--quiet", "-m", `Synthetic revision ${revision}`);
    commits.push(git("rev-parse", "HEAD"));
    const worktree = path.join(directory, `worktree-${revision}`);
    git("worktree", "add", "--quiet", "--detach", worktree, commits.at(-1)!);
    worktrees.push(worktree);
    fixtureBytes += Buffer.byteLength(revisionText);
    libraries.push(
      templates.map((template, index) => {
        const skillDir = path.join(worktree, ".agents", "skills", template.name);
        const loaded = loadSingleSkillDirectory({
          skillDir,
          source: "agents-skills-project",
          rootRealPath: path.join(worktree, ".agents", "skills"),
        });
        assert(loaded, `Synthetic skill failed loading: ${template.name}`);
        const companion =
          index === 0 ? readFileSync(path.join(skillDir, "companion.js"), "utf8") : undefined;
        fixtureBytes += Buffer.byteLength(loaded.content) + Buffer.byteLength(companion ?? "");
        const bundle =
          values.source === "inline"
            ? prepareSkillBundle([
                { path: "SKILL.md", content: loaded.content, encoding: "utf8" },
                ...(companion === undefined
                  ? []
                  : [{ path: "companion.js", content: companion, encoding: "utf8" as const }]),
              ])
            : undefined;
        return Object.freeze({
          ...loaded.skill,
          ...(bundle ? { contentHash: bundle.revision, readContent: loaded.content } : {}),
        });
      }),
    );
  }
  const uniqueCatalogRevisions = new Set(
    libraries.map((skills) =>
      JSON.stringify(skills.map((skill) => [skill.contentHash, skill.name, skill.description])),
    ),
  ).size;
  return {
    directory,
    worktrees,
    libraries,
    summary: {
      worktrees: worktrees.length,
      commits: new Set(commits).size,
      change: values["worktree-change"],
      uniqueCatalogRevisions,
      // Tracked files in the worktrees; excludes the seed checkout and Git objects.
      fixtureBytes,
    },
    cleanup: () => {
      process.removeListener("exit", cleanup);
      cleanup();
    },
  };
}
const worktreeFixture = worktreeCount ? prepareWorktrees() : undefined;
let authorityChecks = 0;
let permissionChecks = 0;
const queries = ["file search", "scheduled tasks", "message", "guide-3", "no_such_capability"];
async function operation(iteration: number) {
  const variant = catalogPattern[iteration % catalogPattern.length]!;
  const worktreeIndex = iteration % (worktreeFixture?.worktrees.length ?? 1);
  const selectedSkills = (worktreeFixture?.libraries[worktreeIndex] ?? canonicalSkills).slice(
    variant,
  );
  // Readers and result mappings remain run-owned; only text postings can be shared.
  const publishedSkills = values["fresh-publications"]
    ? selectedSkills.map((skill) => {
        const filePath = `node://synthetic/run-${iteration}/${skill.name}/SKILL.md`;
        const baseDir = path.dirname(filePath);
        return {
          ...skill,
          filePath,
          baseDir,
          sourceInfo: { ...skill.sourceInfo, path: filePath, baseDir },
        };
      })
    : selectedSkills;
  const catalog = runtime
    ? runtime.prepareInstalledSkillCatalog({
        snapshot: {
          prompt: "",
          skills: publishedSkills.map(({ name }) => ({ name, skillKey: name })),
          discoverySkills: [...publishedSkills],
        },
        workspaceDir: worktreeFixture?.worktrees[worktreeIndex] ?? "/synthetic/workspace",
        assertCurrent: () => {
          authorityChecks++;
        },
      })
    : templates.map((skill) => ({ ...skill, source: { ...skill.source } }));
  const results = [];
  for (let search = 0; search < searchesPerRun; search++) {
    const query =
      worktreeFixture && search === 0
        ? changedBodyTerm
        : queries[(iteration * searchesPerRun + search) % queries.length]!;
    results.push(
      await searchInstalledSkills(catalog, query, 5, undefined, () => {
        permissionChecks++;
        return !values["metadata-only"];
      }),
    );
  }
  if (worktreeFixture) {
    const prefix = `${worktreeFixture.worktrees[worktreeIndex]!}${path.sep}`;
    for (const result of results) {
      assert(result.skills.every((skill) => skill.location.startsWith(prefix)));
    }
    assert.deepEqual(
      results[0]!.skills.map((skill) => skill.name),
      values["worktree-change"] === "body" &&
        worktreeIndex >= Math.ceil(worktreeCount / 2) &&
        !values["metadata-only"] &&
        selectedSkills.some((skill) => skill.name === templates[0]!.name)
        ? [templates[0]!.name]
        : [],
    );
  }
  return searchesPerRun === 1 ? results[0] : results;
}
// Node 26 precise coverage omits hot tokenizeDocument calls after the first
// collection, even in a direct-call control. Report owner construction counters.
const countedFunctions = [
  "buildLexicalIndex",
  "getTextLexicalIndex",
  "prepareBodyView",
  "readSearchBody",
  "prepareTextLexicalDocument",
];
const coverage = values.counts ? new inspector.Session() : undefined;
coverage?.connect();
if (coverage) {
  await coverage.post("Profiler.enable");
  // Block coverage preserves function-entry counts across async resumptions.
  await coverage.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
}
async function takeCounts() {
  if (!coverage) {
    return undefined;
  }
  const counts = Object.fromEntries(countedFunctions.map((name) => [name, 0]));
  const { result } = await coverage.post("Profiler.takePreciseCoverage");
  for (const script of result) {
    if (
      !script.url.includes("/src/agents/") &&
      script.url !== pathToFileURL(path.resolve(values["catalog-owner"])).href
    ) {
      continue;
    }
    for (const fn of script.functions) {
      if (countedFunctions.includes(fn.functionName)) {
        counts[fn.functionName]! += fn.ranges[0]!.count;
      }
    }
  }
  return counts;
}
await yieldTurn();
global.gc();
const initialHeap = process.memoryUsage().heapUsed;
const coldAt = performance.now();
await operation(0);
const coldMs = performance.now() - coldAt;
const coldCounts = await takeCounts();
for (let index = 0; index < warmup; index++) {
  await operation(index);
}
const warmupCounts = await takeCounts();
authorityChecks = 0;
permissionChecks = 0;
global.gc();
await yieldTurn();
const profiler = values.allocations ? new inspector.Session() : undefined;
profiler?.connect();
if (profiler) {
  await profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const gc: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({
      kind: (entry as import("node:perf_hooks").PerformanceNodeEntry).detail.kind,
      duration: entry.duration,
    });
  }
});
observer.observe({ entryTypes: ["gc"] });
const before = process.memoryUsage();
const hostLoadStart = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
const timings: number[] = [];
const operationCpu = { user: 0, system: 0 };
const digest = createHash("sha256");
for (let index = 0; index < iterations; index++) {
  const operationCpuStart = process.threadCpuUsage();
  const at = performance.now();
  const result = await operation(index);
  timings.push(performance.now() - at);
  const used = process.threadCpuUsage(operationCpuStart);
  operationCpu.user += used.user;
  operationCpu.system += used.system;
  const serialized = JSON.stringify(result);
  // Preserve the worktree-relative result locations, excluding only the random fixture root.
  digest.update(
    worktreeFixture ? serialized.replaceAll(worktreeFixture.directory, "/synthetic") : serialized,
  );
  if (values.collect || index % 20 === 0) {
    await yieldTurn();
    if (values.collect) {
      global.gc();
    }
  }
}
const cpu = process.threadCpuUsage(cpuStart);
const elapsedMs = performance.now() - start;
const warmCounts = await takeCounts();
if (coverage) {
  await coverage.post("Profiler.stopPreciseCoverage");
  await coverage.post("Profiler.disable");
  coverage.disconnect();
}
await yieldTurn();
observer.disconnect();
const after = process.memoryUsage();
let allocatedBytes: number | undefined;
if (profiler) {
  const { profile } = await profiler.post("HeapProfiler.stopSampling");
  const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  profiler.disconnect();
}
await yieldTurn();
global.gc();
const retained = process.memoryUsage();
if (settleMs) {
  await new Promise((resolve) => {
    setTimeout(resolve, settleMs);
  });
  global.gc();
  await yieldTurn();
  global.gc();
}
// Select memory fields only: a complete diagnostic report contains environment secrets.
function memorySnapshot() {
  const diagnostic = process.report.getReport();
  const native =
    values["native-memory"] && process.platform === "darwin"
      ? spawnSync("/usr/bin/footprint", ["-p", String(process.pid)], {
          encoding: "utf8",
          timeout: 5_000,
        })
      : undefined;
  return {
    usage: process.memoryUsage(),
    spaces: getHeapSpaceStatistics(),
    main: "javascriptHeap" in diagnostic ? diagnostic.javascriptHeap : undefined,
    workers:
      "workers" in diagnostic && Array.isArray(diagnostic.workers)
        ? diagnostic.workers.map((worker: { javascriptHeap?: unknown }) => worker.javascriptHeap)
        : undefined,
    native: native
      ? {
          status: native.status,
          output: native.stdout,
          error: native.error?.message ?? native.stderr,
        }
      : values["native-memory"] && process.platform === "linux"
        ? readFileSync("/proc/self/smaps_rollup", "utf8")
        : undefined,
  };
}
const memory = values["memory-report"] ? memorySnapshot() : undefined;
let compacted: ReturnType<typeof memorySnapshot> | undefined;
if (values["memory-report"]) {
  // Attribution only, after timing: distinguish reachable indexes from V8 high-water pages.
  await yieldTurn();
  global.gc({ type: "major", execution: "sync", flavor: "last-resort" });
  compacted = memorySnapshot();
}
timings.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    catalogOwner: values["catalog-owner"],
    runtimeOwner: values["runtime-owner"],
    freshPublications: values["fresh-publications"],
    mode: values.counts ? "counts" : values.allocations ? "allocations" : "timing",
    sampled: values.allocations,
    source: values.source,
    iterations,
    searchesPerRun,
    searches: iterations * searchesPerRun,
    catalogPattern,
    worktreeFixture: worktreeFixture?.summary,
    warmup,
    memory,
    compacted,
    coldCounts,
    warmupCounts,
    warmCounts,
    authorityChecks,
    permissionChecks,
    digest: digest.digest("hex"),
    skillBodies: templates.length,
    textChars: templates.reduce(
      (total, _skill, index) => total + bodies[index % bodies.length]!.content.length,
      0,
    ),
    ...(values.counts
      ? {}
      : {
          coldMs,
          retainedBytesPer100Skills: ((retained.heapUsed - initialHeap) * 100) / templates.length,
          cpu,
          operationCpu,
          elapsedMs,
          allocatedBytes,
          allocatedBytesPerSearch:
            allocatedBytes === undefined
              ? undefined
              : allocatedBytes / (iterations * searchesPerRun),
          latencyUnit: "catalog preparation and searches per run",
          p50Ms: timings[Math.floor(iterations * 0.5)],
          p95Ms: timings[Math.floor(iterations * 0.95)],
          p99Ms: timings[Math.floor(iterations * 0.99)],
          gc,
          before,
          after,
          retained,
        }),
    hostLoadStart,
    hostLoadEnd: loadavg(),
  }),
);
worktreeFixture?.cleanup();
