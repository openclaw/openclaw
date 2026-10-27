/**
 * Synthetic large-checkout empty-diff workload; no existing checkout is mutated.
 * Seed once (sequential file writes):
 *   node --import ./scripts/tsx.mjs scripts/perf/empty-checkout-diff-measure.ts --state-dir .local/empty-diff --seed --files 300000
 * Measure each revision in alternating order:
 *   node --expose-gc --import ./scripts/tsx.mjs scripts/perf/empty-checkout-diff-measure.ts --state-dir .local/empty-diff --boundary owner --iterations 10 --output <result.json>
 * --boundary read exercises the production cache/worker owner; owner calls the
 * uncached collector. --scope all tests branch-relative reads; detach the seeded
 * repository first to make its resolved base equal HEAD. --rewrite rewrites
 * identical contents before each sample;
 * --rewrite-once rewrites before warmup to measure subsequent idle polls;
 * --refresh then refreshes the index outside measurement. --allocations selects
 * a separate sampled-allocation pass (parent isolate only; timings diagnostic).
 * --source-dir <snapshot> substitutes the six owners listed below in parent and
 * worker; save those files with relative paths before editing. --metadata-churn
 * changes a synthetic Git config comment before each sample to force collection.
 * Trace2 is enabled identically in both arms and records real Git command times.
 * --no-trace disables it for timing controls; allocation mode always disables it.
 * Allocation includes parent-isolate read + fixture/bookkeeping allocations,
 * excluding Git children and worker heaps. Memory after drain follows joined
 * worker shutdown and one main-isolate GC, separately from endpoint memory.
 * Acceptance: identical empty results, fewer scans/children, lower CPU or latency;
 * report shared-host load and every sample, without claiming low-count p99 gates.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    files: { type: "string", default: "300000" },
    iterations: { type: "string", default: "10" },
    boundary: { type: "string", default: "owner" },
    scope: { type: "string", default: "uncommitted" },
    rewrite: { type: "boolean" },
    "rewrite-once": { type: "boolean" },
    refresh: { type: "boolean" },
    allocations: { type: "boolean" },
    "no-trace": { type: "boolean" },
    output: { type: "string" },
    "source-dir": { type: "string" },
    "metadata-churn": { type: "boolean" },
  },
});
assert(values["state-dir"], "--state-dir is required");
assert(values.boundary === "owner" || values.boundary === "read");
assert(values.scope === "all" || values.scope === "uncommitted");
assert(!values.refresh || values.rewrite, "--refresh requires --rewrite");
const integer = (key: "files" | "iterations") =>
  parseStrictIntegerOption({
    raw: values[key],
    label: `--${key}`,
    min: 1,
    fallback: 1,
  });
const count = integer("files");
assert(count <= 500000, "--files must not exceed 500000");
const iterations = integer("iterations");
const root = path.resolve(values["state-dir"]);
const repo = path.join(root, "repository");
const marker = path.join(root, "empty-diff-fixture.json");
const trace = path.join(root, `trace-${process.pid}.jsonl`);
const env = {
  ...process.env,
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Synthetic Benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)("git", ["-C", cwd, ...args], { env, maxBuffer: 1024 * 1024 });
const fixtureFile = (index: number) =>
  path.join(repo, "inventory", String(Math.floor(index / 1000)), `${index}.txt`);
if (values.seed) {
  await fs.mkdir(root);
  for (const directory of [repo, env.HOME, env.OPENCLAW_STATE_DIR, env.TMPDIR]) {
    await fs.mkdir(directory);
  }
  const origin = path.join(root, "origin");
  await fs.mkdir(origin);
  await git(origin, "init", "--template=", "--initial-branch=main");
  await git(
    origin,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "test: seed synthetic origin",
  );
  await git(origin, "worktree", "add", "-b", "synthetic", repo, "HEAD");
  for (let index = 0; index < count; index++) {
    if (index % 1000 === 0) {
      await fs.mkdir(path.dirname(fixtureFile(index)), { recursive: true });
    }
    await fs.writeFile(fixtureFile(index), "");
    if (index % 50000 === 49999) {
      console.log(`Seeded ${index + 1} files`);
    }
  }
  await git(repo, "add", ".");
  await git(
    repo,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    "test: seed synthetic tracked files",
  );
  await fs.writeFile(
    marker,
    JSON.stringify({ format: "openclaw-empty-diff-v1", files: count }) + "\n",
  );
  console.log(JSON.stringify({ seeded: count, root }));
} else {
  const fixture: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
  assert(
    fixture &&
      typeof fixture === "object" &&
      "format" in fixture &&
      fixture.format === "openclaw-empty-diff-v1",
  );
  const traceEnabled = !values.allocations && !values["no-trace"];
  Object.assign(process.env, env);
  if (traceEnabled) {
    process.env.GIT_TRACE2_EVENT = trace;
  } else {
    delete process.env.GIT_TRACE2_EVENT;
  }
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const ownerFiles = [
    "src/gateway/control-ui-session-diff-revision.ts",
    "src/gateway/control-ui-session-prs-git.runtime.ts",
    "src/infra/git-read-cache.ts",
    "src/infra/git-read-operations.ts",
    "src/infra/git-worker-contract.ts",
    "src/sessions/session-diff.runtime.ts",
  ];
  const selectedRoot = values["source-dir"] ? path.resolve(values["source-dir"]) : sourceRoot;
  const sourceHashes = Object.fromEntries(
    ownerFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(selectedRoot, file)))
        .digest("hex"),
    ]),
  );
  const preload = path.join(root, `source-loader-${process.pid}.mjs`);
  const loadedLog = path.join(root, `source-loads-${process.pid}.jsonl`);
  // Source workers select their own execArgv. Propagate this same frozen-source
  // selection through that bootstrap only; every measured operation stays real.
  await fs.writeFile(
    preload,
    `
import { registerHooks } from "node:module";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { threadId } from "node:worker_threads";
const root = ${JSON.stringify(sourceRoot)};
const selected = ${JSON.stringify(selectedRoot)};
const files = ${JSON.stringify(ownerFiles)};
registerHooks({ load(url, context, nextLoad) {
  const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
  if (relative === "src/infra/runtime-worker-url.ts") {
    const source = readFileSync(fileURLToPath(url), "utf8");
    const before = '["--import", import.meta.resolve("tsx/esm")]';
    if (!source.includes(before)) throw new Error("Worker preload contract changed");
    return { format: "module-typescript", source: source.replace(before,
      '["--import", import.meta.resolve("tsx/esm"), "--import", ' + JSON.stringify(import.meta.url) + ']'), shortCircuit: true };
  }
  if (!files.includes(relative)) return nextLoad(url, context);
  appendFileSync(${JSON.stringify(loadedLog)}, JSON.stringify({threadId, file: relative}) + "\\n");
  return { format: "module-typescript", source: readFileSync(path.join(selected, relative), "utf8"), shortCircuit: true };
}});
`,
  );
  await import(pathToFileURL(preload).href);
  const { collectCheckoutDiff } = await import("../../src/sessions/session-diff.runtime.js");
  const { loadCheckoutDiff } = await import("../../src/sessions/session-diff.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const input = { cwd: repo, scope: values.scope, summaryOnly: false };
  const read = async () => {
    const result =
      values.boundary === "owner"
        ? await collectCheckoutDiff(input)
        : await loadCheckoutDiff({ ...input, sessionKey: "synthetic-empty-diff" });
    assert(!result.unavailableReason);
    assert.equal(result.files.length, 0);
    assert.equal(result.additions, 0);
    assert.equal(result.deletions, 0);
  };
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const inspector = new Session();
  let drained = false;
  const gc: Array<{ kind: number; durationMs: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = entry.toJSON().detail as { kind: number };
      gc.push({ kind: detail.kind, durationMs: entry.duration });
    }
  });
  try {
    if (values["rewrite-once"]) {
      await fs.writeFile(fixtureFile(0), "");
    }
    await read();
    global.gc?.();
    if (values.allocations) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const common = (await git(repo, "rev-parse", "--git-common-dir")).stdout.trim();
    const config = path.resolve(repo, common, "config");
    const originalConfig = await fs.readFile(config, "utf8");
    const samples = [];
    const memoryBefore = process.memoryUsage();
    await nextTurn();
    observer.observe({ entryTypes: ["gc"] });
    const measurementStarted = performance.now();
    for (let index = 0; index < iterations; index++) {
      if (values["metadata-churn"]) {
        await fs.writeFile(config, originalConfig + `\n# synthetic sample ${index}\n`);
      }
      if (values.rewrite) {
        await fs.writeFile(fixtureFile(0), "");
      }
      if (values.refresh) {
        await git(repo, "update-index", "--refresh");
      }
      if (traceEnabled) {
        await fs.writeFile(trace, "");
      }
      const hostLoad = os.loadavg();
      const cpuBefore = process.cpuUsage();
      const mainCpuBefore = process.threadCpuUsage();
      const started = performance.now();
      await read();
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuBefore);
      const mainCpu = process.threadCpuUsage(mainCpuBefore);
      let gitLstatCount = 0;
      let gitRefreshScans = 0;
      const commands = new Map<string, { args: string[]; elapsedMs?: number }>();
      const traceLines = traceEnabled
        ? (await fs.readFile(trace, "utf8")).split("\n").filter(Boolean)
        : [];
      for (const line of traceLines) {
        const event = JSON.parse(line) as {
          sid: string;
          event: string;
          argv?: string[];
          t_abs?: number;
          key?: string;
          value?: string;
        };
        if (event.event === "data" && event.key === "preload/sum_lstat") {
          gitLstatCount += Number(event.value);
        }
        if (event.event === "data" && event.key === "refresh/sum_scan") {
          gitRefreshScans += Number(event.value);
        }
        if (event.event === "start" && event.argv) {
          commands.set(event.sid, { args: event.argv });
        }
        if (event.event === "exit" && commands.has(event.sid)) {
          commands.get(event.sid)!.elapsedMs = (event.t_abs ?? 0) * 1000;
        }
      }
      samples.push({
        elapsedMs,
        processCpuMs: (cpu.user + cpu.system) / 1000,
        mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
        gitLstatCount,
        gitRefreshScans,
        hostLoad,
        commands: [...commands.values()],
      });
    }
    const elapsedMs = performance.now() - measurementStarted;
    await nextTurn();
    observer.disconnect();
    const profile = values.allocations
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const report = {
      fixture,
      sourceHashes,
      elapsedMs,
      gc,
      memoryBefore,
      boundary: values.boundary,
      scope: values.scope,
      iterations,
      rewrite: Boolean(values.rewrite),
      rewriteOnce: Boolean(values["rewrite-once"]),
      refresh: Boolean(values.refresh),
      allocationPass: Boolean(values.allocations),
      metadataChurn: Boolean(values["metadata-churn"]),
      traceEnabled,
      allocatedBytesPerDiff: profile ? allocated(profile.head) / iterations : undefined,
      memory: process.memoryUsage(),
      loadedSources: (await fs.readFile(loadedLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
      samples,
    };
    await drainGlobalSingletonLifecycleState();
    drained = true;
    global.gc?.();
    await nextTurn();
    const completedReport = { ...report, memoryAfterDrain: process.memoryUsage() };
    if (values.output) {
      await fs.writeFile(
        path.resolve(values.output),
        JSON.stringify(completedReport, null, 2) + "\n",
      );
    }
    console.log(JSON.stringify(completedReport));
  } finally {
    inspector.disconnect();
    observer.disconnect();
    if (!drained) {
      await drainGlobalSingletonLifecycleState();
    }
    await fs.unlink(trace).catch(() => {});
    await fs.unlink(preload).catch(() => {});
    await fs.unlink(loadedLog).catch(() => {});
  }
}
