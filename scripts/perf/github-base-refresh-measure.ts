/**
 * Measure base-refresh capture and overlay preparation on 24,000 synthetic files.
 * Usage: node --import ./scripts/tsx.mjs scripts/perf/github-base-refresh-measure.ts
 *   --fixture .local/github-base-refresh --mode prepare|base|candidate|compare
 *   [--files 24000 --samples 5 --operation refresh|paths]
 * Prepare once, then measure base before editing and compare after the worker move.
 * `base` reproduces the original capture/parse/overlay/conflict/serialize sequence;
 * `candidate` calls the production workspace worker operation. `--operation paths`
 * isolates canonical baseline parsing and eligible-path projection. Compare alternates
 * AB/BA with one unmeasured warmup per arm; no forced GC or allocation profiler.
 * Timers sample longest main-loop scheduling gap, including OS scheduling noise;
 * mainThreadCpuMs is thread CPU, totalCpuMs includes worker threads. This owner
 * measurement excludes Git merge, projection settlement, and publication; it
 * supplements, never replaces, the canonical Team-shaped Gateway test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  manifestNodes,
  sameEntry,
} from "../../src/gateway/worker-environments/workspace-manifest-comparison.js";
import { applyWorkspaceSourceOverlay } from "../../src/gateway/worker-environments/workspace-manifest-overlay.js";
import { captureWorkspaceSnapshot } from "../../src/gateway/worker-environments/workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "../../src/gateway/worker-environments/workspace-manifest.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    mode: { type: "string", default: "compare" },
    files: { type: "string", default: "24000" },
    samples: { type: "string", default: "5" },
    operation: { type: "string", default: "refresh" },
  },
});
assert.ok(values.fixture, "--fixture is required");
assert.ok(["prepare", "base", "candidate", "compare"].includes(values.mode));
assert.ok(["refresh", "paths"].includes(values.operation));
const fixture = path.resolve(values.fixture);
const count = Number(values.files);
const samples = Number(values.samples);
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const beforeRoot = path.join(fixture, "before");
const afterRoot = path.join(fixture, "after");
const baseCommit = "a".repeat(40);
const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const original = "synthetic original\n";
const incoming = "synthetic incoming\n";
const file = (name: string, content: string) => ({
  path: name,
  type: "file" as const,
  mode: 0o644,
  size: Buffer.byteLength(content),
  sha256: createHash("sha256").update(content).digest("hex"),
});
if (values.mode === "prepare") {
  await fs.mkdir(fixture, { recursive: false });
  await fs.mkdir(beforeRoot);
  await fs.mkdir(afterRoot);
  const directories = ["src"];
  const entries: WorkerWorkspaceManifest["entries"] = [];
  const expected: WorkerWorkspaceManifest["entries"] = [];
  for (let index = 0; index < count; index++) {
    const directory = `src/group-${String(Math.floor(index / 100)).padStart(3, "0")}`;
    if (index % 100 === 0) {
      directories.push(directory);
      await fs.mkdir(path.join(beforeRoot, directory), { recursive: true });
      await fs.mkdir(path.join(afterRoot, directory), { recursive: true });
    }
    const name = `${directory}/file-${String(index).padStart(5, "0")}.ts`;
    await fs.writeFile(path.join(beforeRoot, name), original);
    const changed = index % 100 === 0;
    if (changed) {
      await fs.writeFile(path.join(afterRoot, name), incoming);
    } else {
      await fs.link(path.join(beforeRoot, name), path.join(afterRoot, name));
    }
    entries.push(file(name, original));
    expected.push(file(name, changed ? incoming : original));
  }
  // Accepted saved data is retained even though neither Git checkout contains it.
  const saved = file("saved.txt", "saved workspace data\n");
  entries.push(saved);
  expected.push(saved);
  const baseRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit,
    entries,
    directories,
  });
  const expectedRaw = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit,
    entries: expected,
    directories,
  });
  await fs.writeFile(path.join(fixture, "baseline.json"), baseRaw);
  await fs.writeFile(path.join(fixture, "expected.json"), expectedRaw);
  console.log(
    JSON.stringify({
      prepared: count,
      changed: Math.ceil(count / 100),
      baseRef: digest(baseRaw),
      expectedRef: digest(expectedRaw),
    }),
  );
} else {
  const baseRaw = await fs.readFile(path.join(fixture, "baseline.json"), "utf8");
  const expectedRaw = await fs.readFile(path.join(fixture, "expected.json"), "utf8");
  const baseRef = digest(baseRaw);
  const buildCacheInputs: string[] = [];
  // The fixture's explicit wire paths are independent of the production projection.
  const expectedPathDocument: { entries: { path: string }[] } = JSON.parse(baseRaw);
  const expectedPaths = new Set(expectedPathDocument.entries.map((entry) => entry.path));
  type Arm = "base" | "candidate";
  const run = async (arm: Arm) => {
    if (arm === "candidate") {
      const { prepareWorkspaceBaseRefresh, workspaceManifestPaths } =
        await import("../../src/gateway/worker-environments/workspace-manifest-worker.js");
      return values.operation === "paths"
        ? await workspaceManifestPaths(
            { rawManifest: baseRaw, manifestRef: baseRef },
            buildCacheInputs,
          )
        : await prepareWorkspaceBaseRefresh({
            beforeRoot,
            afterRoot,
            baseCommit,
            baseRaw,
            baseRef,
            buildCacheInputs,
            action: "refresh_base",
          });
    }
    if (values.operation === "paths") {
      return new Set(
        manifestNodes(parseWorkerWorkspaceManifest(baseRaw, baseRef, buildCacheInputs)).keys(),
      );
    }
    const before = await captureWorkspaceSnapshot({ root: beforeRoot, baseCommit });
    const after = await captureWorkspaceSnapshot({ root: afterRoot, baseCommit });
    const accepted = parseWorkerWorkspaceManifest(baseRaw, baseRef, buildCacheInputs);
    const current = applyWorkspaceSourceOverlay(before.manifest, accepted, after.manifest);
    current.buildCacheInputs = [
      ...new Set([...buildCacheInputs, ...after.manifest.entries.map((entry) => entry.path)]),
    ];
    const priorNodes = manifestNodes(before.manifest);
    const currentNodes = manifestNodes(current);
    for (const [name, entry] of manifestNodes(accepted)) {
      if (!priorNodes.has(name) && !sameEntry(entry, currentNodes.get(name))) {
        throw new Error(
          `The selected base conflicts with saved workspace data at ${name}; move that saved file before retrying refresh_base.`,
        );
      }
    }
    const rawManifest = serializeWorkerWorkspaceManifest(current);
    return {
      rawManifest,
      manifestRef: digest(rawManifest),
      buildCacheInputs: current.buildCacheInputs,
    };
  };
  const verify = (result: Awaited<ReturnType<typeof run>>, arm: Arm) => {
    if (result instanceof Set) {
      assert.deepEqual(result, expectedPaths, `${arm} golden paths`);
    } else {
      assert.equal(result.rawManifest, expectedRaw, `${arm} golden manifest`);
      assert.equal(result.manifestRef, digest(expectedRaw));
    }
  };
  const arms: Arm[] =
    values.mode === "compare"
      ? ["base", "candidate"]
      : values.mode === "base"
        ? ["base"]
        : ["candidate"];
  try {
    for (const arm of arms) {
      const result = await run(arm);
      verify(result, arm);
    }
    for (let pair = 0; pair < samples; pair++) {
      for (const arm of pair % 2 ? arms.toReversed() : arms) {
        await yieldImmediate();
        let previous = performance.now();
        let maxMainThreadBlockMs = 0;
        let timerSamples = 0;
        const record = () => {
          const now = performance.now();
          maxMainThreadBlockMs = Math.max(maxMainThreadBlockMs, now - previous);
          previous = now;
          timerSamples++;
        };
        const timer = setInterval(record, 1);
        const started = performance.now();
        const thread = process.threadCpuUsage();
        const cpu = process.cpuUsage();
        const loadBefore = os.loadavg();
        let result: Awaited<ReturnType<typeof run>>;
        try {
          result = await run(arm);
          await yieldImmediate();
          record();
        } finally {
          clearInterval(timer);
        }
        const elapsedMs = performance.now() - started;
        const total = process.cpuUsage(cpu);
        const main = process.threadCpuUsage(thread);
        verify(result, arm);
        console.log(
          JSON.stringify({
            arm,
            operation: values.operation,
            pair: pair + 1,
            elapsedMs,
            mainThreadCpuMs: (main.user + main.system) / 1000,
            totalCpuMs: (total.user + total.system) / 1000,
            maxMainThreadBlockMs,
            timerSamples,
            loadBefore,
            loadAfter: os.loadavg(),
            rssMiB: process.memoryUsage().rss / 1024 ** 2,
            heapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
            manifestRef: result instanceof Set ? baseRef : result.manifestRef,
            paths: result instanceof Set ? result.size : undefined,
          }),
        );
      }
    }
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
}
