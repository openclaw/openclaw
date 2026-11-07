/**
 * Synthetic reconciliation ownership and responsiveness proof (no operator state).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-reconciliation-measure.ts \
 *   --root /task/proof --count 20000 --bytes 24576 --workload apply
 * Workloads: patch, apply, conflict-apply, conflicts. --source selects a pinned
 * checkout for alternating baseline/candidate and A/A controls. --measure cpu
 * or allocation records a separate diagnostic run at --profile <filename>.
 * conflict-apply uses real Git through a task-local wrapper: after apply succeeds,
 * a child restores half the files to base before Git completion reaches the host.
 * This deterministically models local edits between apply and final preflight;
 * unrelated conflicts occupy the other half. Measured concurrent fixture writes stay off main.
 * Acceptance: identical outcomes, <=200ms maximum main-thread heartbeat gap,
 * bounded rejection above 50k changed paths, and no unexplained >=20% regression.
 * Use an external process timeout for baseline stalls. Fixture preparation and
 * cleanup are outside measurement. Filesystem choice belongs to --root/TMPDIR;
 * these owners do not read agent/session databases, so no database is padded.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { WorkerWorkspaceManifestEntry } from "../../src/gateway/worker-environments/workspace-manifest.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    source: { type: "string" },
    count: { type: "string", default: "20000" },
    bytes: { type: "string", default: "24576" },
    workload: { type: "string", default: "apply" },
    measure: { type: "string", default: "timing" },
    profile: { type: "string" },
  },
});
assert(values.root, "--root must name task-owned fixture storage");
assert(["patch", "apply", "conflict-apply", "conflicts"].includes(values.workload));
assert(["timing", "cpu", "allocation"].includes(values.measure));
const count = parseStrictIntegerOption({
  raw: values.count,
  label: "--count",
  min: 2,
  fallback: 20000,
});
const bytes = parseStrictIntegerOption({
  raw: values.bytes,
  label: "--bytes",
  min: 80,
  fallback: 24576,
});
const source = path.resolve(values.source ?? fileURLToPath(new URL("../..", import.meta.url)));
const sourceUrl = (relative: string) => pathToFileURL(path.join(source, "src", relative)).href;
const { applyStagedWorkerWorkspace } = (await import(
  sourceUrl("gateway/worker-environments/workspace-reconcile-apply.ts")
)) as typeof import("../../src/gateway/worker-environments/workspace-reconcile-apply.js");
const recovery = (await import(
  sourceUrl("gateway/worker-environments/workspace-reconcile-recovery.ts")
)) as typeof import("../../src/gateway/worker-environments/workspace-reconcile-recovery.js");
const worker = (await import(
  sourceUrl("gateway/worker-environments/workspace-manifest-worker.ts")
)) as typeof import("../../src/gateway/worker-environments/workspace-manifest-worker.js");
const { prepareWorkspaceReconciliation } = (await import(
  sourceUrl("gateway/worker-environments/workspace-manifest-comparison.ts")
)) as typeof import("../../src/gateway/worker-environments/workspace-manifest-comparison.js");
const { retainedConflictPaths } = (await import(
  sourceUrl("gateway/worker-environments/workspace-reconcile-core.ts")
)) as typeof import("../../src/gateway/worker-environments/workspace-reconcile-core.js");
const { drainGlobalSingletonLifecycleState } = (await import(
  sourceUrl("shared/global-singleton.ts")
)) as typeof import("../../src/shared/global-singleton.js");
await fs.mkdir(values.root, { recursive: true });
const fixture = await fs.mkdtemp(path.join(path.resolve(values.root), "workspace-reconciliation-"));
const root = path.join(fixture, "local");
const stagingRoot = path.join(fixture, "staged");
const entries: WorkerWorkspaceManifestEntry[] = [];
const baseEntries: WorkerWorkspaceManifestEntry[] = [];
const half = Math.floor(count / 2);
const old = Buffer.from("base\n");
const hash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
const previousPath = process.env.PATH;
try {
  await fs.mkdir(root);
  await fs.mkdir(stagingRoot);
  if (values.workload !== "conflicts") {
    const template = Buffer.alloc(bytes);
    for (let index = 0; index < bytes; index++) {
      template[index] =
        index % 80 === 79 ? 10 : 32 + ((index * 31 + Math.floor(index / 80) * 7) % 90);
    }
    for (let index = 0; index < count; index++) {
      const entryPath = `dist/module-${Math.floor(index / 256)}/artifact-${index}.js`;
      const content = Buffer.from(template);
      content.write(`// generated output ${String(index).padStart(8, "0")}\n`);
      if (index % 256 === 0) {
        await fs.mkdir(path.dirname(path.join(stagingRoot, entryPath)), { recursive: true });
        if (values.workload === "conflict-apply") {
          await fs.mkdir(path.dirname(path.join(root, entryPath)), { recursive: true });
        }
      }
      await fs.writeFile(path.join(stagingRoot, entryPath), content);
      entries.push({
        path: entryPath,
        type: "file",
        mode: 0o644,
        size: bytes,
        sha256: hash(content),
      });
      if (values.workload === "conflict-apply") {
        await fs.writeFile(path.join(root, entryPath), index < half ? old : "local edit\n");
        baseEntries.push({
          path: entryPath,
          type: "file",
          mode: 0o644,
          size: old.length,
          sha256: hash(old),
        });
      }
    }
  }
  if (values.workload === "conflict-apply") {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = path.join(fixture, "bin");
    const restorePaths = path.join(fixture, "restore.json");
    await fs.mkdir(bin);
    await fs.writeFile(
      restorePaths,
      JSON.stringify(entries.slice(0, half).map((entry) => path.join(root, entry.path))),
    );
    // Actual Git performs the mutation; only the competing writer's timing is controlled.
    await fs.writeFile(
      path.join(bin, "git"),
      `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const args=process.argv.slice(2);
const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(result.status===0 && args.includes('apply')) {
  for(const target of JSON.parse(fs.readFileSync(${JSON.stringify(restorePaths)},'utf8'))) fs.writeFileSync(target,'base\\n');
}
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  }
  const base = { version: 1 as const, baseCommit: null, entries: baseEntries };
  const current = { version: 1 as const, baseCommit: null, entries };
  const reconciliation = prepareWorkspaceReconciliation(base, current);
  const applyPaths = new Set(
    Array.from({ length: half }, (_, index) => `src/module-${index}/index.js`),
  );
  const conflictPaths = Array.from(
    { length: count - half },
    (_, index) => `extensions/module-${index}/index.js`,
  );
  const inspector = values.measure === "timing" ? undefined : new Session();
  inspector?.connect();
  if (values.measure === "cpu") {
    await inspector?.post("Profiler.enable");
    await inspector?.post("Profiler.start");
  } else if (values.measure === "allocation") {
    await inspector?.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  globalThis.gc?.();
  const hostLoad = loadavg();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let previousTick = performance.now();
  let tickMaxMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    tickMaxMs = Math.max(tickMaxMs, now - previousTick);
    previousTick = now;
  }, 10);
  await delay(20);
  const before = process.memoryUsage();
  const cpuStart = process.cpuUsage();
  const mainCpuStart = process.threadCpuUsage();
  const start = performance.now();
  let outcome: object;
  try {
    if (values.workload === "conflicts") {
      outcome = {
        conflictCount: retainedConflictPaths(
          { applyPaths, conflictPaths, blockingConflictPaths: [] },
          applyPaths,
        ).length,
      };
    } else if (values.workload === "patch") {
      // The baseline exported patch generation from recovery; the candidate owns it in the worker adapter.
      const patch = await (worker.createWorkspacePatch ?? recovery.createWorkspacePatch)({
        root,
        stagingRoot,
        baseEntries,
        appliedEntries: entries,
      });
      outcome = { patchBytes: patch.patch.byteLength, packBytes: patch.basePack.byteLength };
    } else {
      const result = await applyStagedWorkerWorkspace({
        root,
        stagingRoot,
        baseManifestRef: `sha256:${"0".repeat(64)}`,
        currentManifestRef: `sha256:${"1".repeat(64)}`,
        current,
        reconciliation,
        assertCurrent: () => {},
        journal: {
          load: async () => undefined,
          begin: async () => {},
          commit: async () => {},
          abort: async () => {},
        },
        acceptance: { kind: "reconcile" },
      });
      assert.equal(result.manifest.entries.length, count);
      if (values.workload === "conflict-apply") assert.equal(result.conflictPaths.length, count);
      outcome = {
        manifestEntries: result.manifest.entries.length,
        conflictCount: result.conflictPaths.length,
      };
    }
  } catch (error) {
    outcome = { error: error instanceof Error ? error.message : String(error) };
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const mainCpu = process.threadCpuUsage(mainCpuStart);
  const after = process.memoryUsage();
  await delay(20);
  clearInterval(heartbeat);
  histogram.disable();
  let sampledBytes: number | undefined;
  if (values.measure === "cpu") {
    const result = await inspector?.post("Profiler.stop");
    if (result && values.profile)
      await fs.writeFile(values.profile, JSON.stringify(result.profile));
  } else if (values.measure === "allocation") {
    const result = await inspector?.post("HeapProfiler.stopSampling");
    if (result) {
      sampledBytes = sumSampledHeapBytes(result.profile.head);
      if (values.profile) await fs.writeFile(values.profile, JSON.stringify(result.profile));
    }
  }
  inspector?.disconnect();
  // Give the existing worker owner its one-second idle-GC window on both arms.
  await delay(1500);
  globalThis.gc?.();
  const retained = process.memoryUsage();
  console.log(
    JSON.stringify({
      workload: values.workload,
      measure: values.measure,
      count,
      totalBytes: count * bytes,
      wallMs,
      cpu,
      mainCpu,
      before,
      after,
      retained,
      hostLoad,
      tickMaxMs,
      loopMaxMs: histogram.max / 1e6,
      loopP99Ms: histogram.percentile(99) / 1e6,
      sampledBytes,
      outcome,
    }),
  );
} finally {
  process.env.PATH = previousPath;
  await drainGlobalSingletonLifecycleState();
  await fs.rm(fixture, { recursive: true, force: true });
}
