/**
 * Workspace snapshots, setup, publication, and deletion plans through their real owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-snapshot-read-measure.ts \
 *   --root <new-isolated-state-dir> --workspace <synthetic-workspace> \
 *   --checkout <baseline-or-candidate> --workload snapshot|setup|publication|deletion-plan|legacy-reset \
 *   --mode counts|timing|allocation --iterations 1000
 * Run five alternating A/B samples, retaining same-source A/A controls. The workspace
 * is read-only for snapshot; other workloads create their fixture under --root.
 * Setup reports the first full setup separately, then repeats unchanged setup;
 * publication uses unique files in a precreated directory. Fixture creation is
 * outside samples. Cold setup can spawn Git: process CPU excludes child CPU.
 * Legacy reset precreates distinct small workspaces with owned setup/attestation
 * files and a foreign claim. Each sample prepares and removes one workspace's
 * retired files; containment is checked before removal, outcomes after measurement.
 * Report reset isolation's wall/CPU cost explicitly, including any regression.
 * Acceptance: zero synchronous workspace observation calls on warm reads, unchanged
 * snapshots and no worker dispatch. Report async CPU/allocation cost separately;
 * setup/publication must remove synchronous host work. Report the isolation cost
 * in warm latency and total process CPU, plus worker dispatches/messages and main-thread
 * allocations separately; neither main heap sampling nor process CPU includes
 * child Git allocation/CPU. This is not whole-Gateway latency or throughput proof.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { observeBootstrapWorkers } from "./bootstrap-worker-telemetry.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    workspace: { type: "string" },
    checkout: { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    mode: { type: "string", default: "timing" },
    workload: { type: "string", default: "snapshot" },
    iterations: { type: "string", default: "1000" },
    "expected-bootstrap-warm-bytes": { type: "string" },
    "expected-bootstrap-workers": { type: "string" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["counts", "timing", "allocation"].includes(values.mode));
assert(
  [
    "snapshot",
    "setup",
    "publication",
    "deletion-plan",
    "legacy-reset",
    "bootstrap-small",
    "bootstrap-large",
  ].includes(values.workload),
);
assert(values.workload !== "snapshot" || values.workspace, "Snapshot requires --workspace");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 1000,
});
const bootstrap = values.workload.startsWith("bootstrap-");
const expectedBootstrapWorkers = bootstrap
  ? parseStrictIntegerOption({
      raw: values["expected-bootstrap-workers"],
      label: "expected-bootstrap-workers",
      min: 0,
      fallback: -1,
    })
  : 0;
if (bootstrap) {
  assert(
    values["expected-bootstrap-workers"] !== undefined,
    "Declare the qualified expected worker population",
  );
}
const bootstrapFileBytes = values.workload === "bootstrap-large" ? 512 * 1024 : 4096;
const root = path.resolve(values.root);
const workspace =
  values.workload === "snapshot"
    ? fs.realpathSync(values.workspace!)
    : path.join(root, "workspace");
const checkout = path.resolve(values.checkout);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
if (values.workload === "legacy-reset") {
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
}
const bootstrapObservation = bootstrap
  ? await observeBootstrapWorkers(values.mode, root)
  : undefined;
const load = (file: string) => import(pathToFileURL(path.join(checkout, file)).href);
const source = [
  "workspace-state-read.ts",
  "workspace-state-store.ts",
  "workspace-state-guard.ts",
  "workspace-state-identity.ts",
  "workspace-legacy-state.ts",
  ...(values.workload === "snapshot"
    ? []
    : [
        "workspace.ts",
        "workspace-file-read.ts",
        "workspace-file-cache.ts",
        "workspace-bootstrap-read.ts",
        "workspace-filesystem.types.ts",
        "workspace-preparation.ts",
        "workspace-bootstrap-publish.ts",
        "workspace-filesystem.ts",
        "workspace-filesystem.worker.ts",
      ]),
]
  .map((file) => {
    const target = path.join(checkout, "src/agents", file);
    return fs.existsSync(target) ? fs.readFileSync(target) : `absent:${file}`;
  })
  .join("\n");
const { readCanonicalWorkspaceStateSnapshot: read } = (await load(
  "src/agents/workspace-state-read.ts",
)) as typeof import("../../src/agents/workspace-state-read.js");
const { mergeWorkspaceSetupState: merge, prepareWorkspaceStateDeletion } = (await load(
  "src/agents/workspace-state-store.ts",
)) as typeof import("../../src/agents/workspace-state-store.js");
const { closeOpenClawStateDatabaseAsync: close } = (await load(
  "src/state/openclaw-state-db.ts",
)) as typeof import("../../src/state/openclaw-state-db.js");
const { getTrackedWorkerLifecycleSnapshot } = (await load(
  "src/infra/worker-cpu.ts",
)) as typeof import("../../src/infra/worker-cpu.js");
const { getWorkerMessageMetrics } = (await load(
  "src/infra/worker-message-metrics.ts",
)) as typeof import("../../src/infra/worker-message-metrics.js");
const { drainGlobalSingletonLifecycleState } = (await load(
  "src/shared/global-singleton.ts",
)) as typeof import("../../src/shared/global-singleton.js");
function workerCounts(): Record<string, number> {
  return Object.fromEntries([
    ...getTrackedWorkerLifecycleSnapshot().workerLifecycle.map(
      (entry) => [`started.${entry.script}`, entry.started] as const,
    ),
    ...getWorkerMessageMetrics().flatMap((entry) => [
      [`messages.${entry.direction}.${entry.kind}`, entry.messages] as const,
      [`payloadBytes.${entry.direction}.${entry.kind}`, entry.payloadBytes] as const,
    ]),
  ]);
}
function countDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
  );
}
const inspector = new Session();
const counts: Record<string, number> = {};
const restores: (() => void)[] = [];
try {
  let operation: () => Promise<void>;
  let verify: (() => Promise<void>) | undefined;
  if (values.workload === "snapshot") {
    await merge(workspace, { setupCompletedAt: "2026-01-01T00:00:00.000Z" });
    const expected = await read(workspace);
    operation = async () => assert.deepEqual(await read(workspace), expected);
  } else {
    await fs.promises.mkdir(workspace);
    if (bootstrap) {
      const { loadWorkspaceBootstrapFiles } = (await load(
        "src/agents/workspace.js",
      )) as typeof import("../../src/agents/workspace.js");
      const names = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"] as const;
      const content = "x".repeat(bootstrapFileBytes);
      for (const name of names) {
        await fs.promises.writeFile(path.join(workspace, name), content);
      }
      operation = async () => {
        const files = await loadWorkspaceBootstrapFiles(workspace, names);
        assert.equal(files.length, names.length);
        for (const file of files) {
          assert.equal(file.missing, false);
          assert.equal(file.content, content);
        }
      };
    } else if (values.workload === "legacy-reset") {
      const {
        prepareLegacyWorkspaceStateReset,
        removeLegacyWorkspaceStateForReset,
        resolveLegacyWorkspaceSourcePaths,
        LEGACY_WORKSPACE_ATTESTATION_HEADER,
        WORKSPACE_DOCTOR_CLAIM_SUFFIX,
      } = (await load(
        "src/agents/workspace-legacy-state.ts",
      )) as typeof import("../../src/agents/workspace-legacy-state.js");
      const prefix = `${root}${path.sep}`;
      const fixtures: {
        dir: string;
        owned: string[];
        foreign: string;
        result?: Awaited<ReturnType<typeof removeLegacyWorkspaceStateForReset>>;
      }[] = [];
      for (let index = 0; index < iterations + 21; index++) {
        const dir = path.join(workspace, `reset-${index}`);
        await fs.promises.mkdir(dir);
        const paths = resolveLegacyWorkspaceSourcePaths(dir, {
          env: process.env,
          homedir: () => root,
        });
        const owned = [
          paths.setupStatePaths[0]!,
          paths.stateDirAttestationPaths[0]!,
          paths.siblingAttestationPaths[0]!,
        ];
        const foreign = `${paths.siblingAttestationPaths[0]}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`;
        for (const file of [...owned, foreign]) {
          assert(file.startsWith(prefix), `Fixture escaped task root: ${file}`);
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          await fs.promises.writeFile(
            file,
            file === foreign
              ? "foreign claim\n"
              : `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\nsynthetic\n`,
          );
        }
        fixtures.push({ dir, owned, foreign });
      }
      let next = 0;
      operation = async () => {
        const fixture = fixtures[next++]!;
        const plan = await prepareLegacyWorkspaceStateReset(fixture.dir);
        for (const candidate of plan.candidates) {
          assert(
            candidate.sourcePath.startsWith(prefix),
            `Cleanup escaped task root: ${candidate.sourcePath}`,
          );
        }
        fixture.result = await removeLegacyWorkspaceStateForReset(plan);
      };
      verify = async () => {
        for (const fixture of fixtures) {
          assert(fixture.result);
          assert.deepEqual(fixture.result.warnings, []);
          assert.deepEqual(fixture.result.removedPaths.toSorted(), fixture.owned.toSorted());
          assert.equal(await fs.promises.readFile(fixture.foreign, "utf8"), "foreign claim\n");
          for (const file of fixture.owned) {
            await assert.rejects(fs.promises.lstat(file), { code: "ENOENT" });
          }
        }
      };
    } else if (values.workload === "deletion-plan") {
      const expected = await prepareWorkspaceStateDeletion(workspace);
      operation = async () =>
        assert.deepEqual(await prepareWorkspaceStateDeletion(workspace), expected);
    } else if (values.workload === "setup") {
      const { ensureAgentWorkspace } = (await load(
        "src/agents/workspace.ts",
      )) as typeof import("../../src/agents/workspace.js");
      operation = async () => {
        const result = await ensureAgentWorkspace({ dir: workspace, ensureBootstrapFiles: true });
        assert.equal(result.dir, workspace);
        assert.equal(result.bootstrapPending, true);
      };
    } else {
      const { publishBootstrapFile } = (await load(
        "src/agents/workspace-bootstrap-publish.ts",
      )) as typeof import("../../src/agents/workspace-bootstrap-publish.js");
      let next = 0;
      operation = async () => {
        assert.equal(
          await publishBootstrapFile(
            path.join(workspace, `publication-${next++}.md`),
            "Synthetic instructions\n",
          ),
          true,
        );
      };
    }
  }
  const coldWorkers = workerCounts();
  const coldCpu = process.cpuUsage();
  const coldThread = process.threadCpuUsage();
  const coldStart = performance.now();
  bootstrapObservation?.beginCounts();
  if (values.workload !== "snapshot") {
    await operation();
  }
  const coldDescriptorReads = bootstrapObservation?.endCounts();
  if (bootstrap && values.mode === "counts") {
    assert(coldDescriptorReads);
    assert.equal(
      coldDescriptorReads.main.bytes + coldDescriptorReads.workers.bytes,
      4 * bootstrapFileBytes,
      "Cold read observer did not capture all four actual files",
    );
  }
  const coldElapsedMs = performance.now() - coldStart;
  const coldThreadUsed = process.threadCpuUsage(coldThread);
  const coldCpuUsed = process.cpuUsage(coldCpu);
  const cold = {
    elapsedMs: coldElapsedMs,
    descriptorReads: coldDescriptorReads,
    mainCpuUs: coldThreadUsed.user + coldThreadUsed.system,
    processCpuUs: coldCpuUsed.user + coldCpuUsed.system,
    workerCounts: countDelta(coldWorkers, workerCounts()),
    gitInitialization: values.workload === "setup" ? "best-effort; child CPU unmeasured" : "none",
    prewarmed: values.workload === "deletion-plan",
  };
  for (let index = 0; index < 20; index++) {
    await operation();
  }
  if (values.mode === "counts") {
    for (const method of Object.getOwnPropertyNames(fs)) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(fs, method);
      const value = ownDescriptor?.value;
      if (!method.endsWith("Sync") || typeof value !== "function") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(fs, method)!;
      Object.defineProperty(fs, method, {
        ...descriptor,
        value: new Proxy(value, {
          apply(target, receiver, args) {
            counts[method] = (counts[method] ?? 0) + 1;
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
      restores.push(() => Object.defineProperty(fs, method, descriptor));
    }
    const realpath = fs.realpathSync.native;
    fs.realpathSync.native = new Proxy(realpath, {
      apply(target, receiver, args) {
        counts.realpathNative = (counts.realpathNative ?? 0) + 1;
        return Reflect.apply(target, receiver, args);
      },
    });
    restores.push(() => {
      fs.realpathSync.native = realpath;
    });
    for (const method of [
      "stat",
      "lstat",
      "realpath",
      "readdir",
      "mkdir",
      "open",
      "access",
      "rm",
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(fs.promises, method)!;
      Object.defineProperty(fs.promises, method, {
        ...descriptor,
        value: new Proxy(fs.promises[method], {
          apply(target, receiver, args) {
            counts[`async.${method}`] = (counts[`async.${method}`] ?? 0) + 1;
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
      restores.push(() => Object.defineProperty(fs.promises, method, descriptor));
    }
    syncBuiltinESMExports();
  }
  const observedWorkerPopulation = bootstrapObservation?.assertPopulation(expectedBootstrapWorkers);
  global.gc();
  if (values.mode === "allocation" && !bootstrap) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const allocationBefore =
    bootstrap && values.mode === "allocation"
      ? await bootstrapObservation!.memory(expectedBootstrapWorkers)
      : undefined;
  bootstrapObservation?.beginCounts();
  const hostLoad = loadavg();
  const workersBefore = workerCounts();
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const start = performance.now();
  const latencies: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const began = performance.now();
    await operation();
    latencies.push(performance.now() - began);
  }
  const elapsedMs = performance.now() - start;
  const thread = process.threadCpuUsage(threadBefore);
  const cpu = process.cpuUsage(cpuBefore);
  bootstrapObservation?.assertPopulation(expectedBootstrapWorkers);
  const workerWork = countDelta(workersBefore, workerCounts());
  const descriptorReads = bootstrapObservation?.endCounts();
  if (bootstrap && values.mode === "counts") {
    assert(
      values["expected-bootstrap-warm-bytes"] !== undefined,
      "Counts require an explicit expected byte total for the selected revision",
    );
    const expectedBytes = parseStrictIntegerOption({
      raw: values["expected-bootstrap-warm-bytes"],
      label: "expected-bootstrap-warm-bytes",
      min: 0,
      fallback: 0,
    });
    assert(descriptorReads);
    assert.equal(
      descriptorReads.main.bytes + descriptorReads.workers.bytes,
      expectedBytes,
      "Warm bounded read bytes differ from the declared workload",
    );
    assert.equal(descriptorReads.main.errors + descriptorReads.workers.errors, 0);
  }
  const allocationAfter = allocationBefore
    ? await bootstrapObservation!.memory(expectedBootstrapWorkers)
    : undefined;
  const heapAllocation =
    allocationBefore && allocationAfter
      ? bootstrapObservation!.allocationDelta(allocationBefore, allocationAfter)
      : undefined;
  const filesystemCounts = { ...counts };
  const hostLoadAfter = loadavg();
  const allocatedBytes =
    values.mode === "allocation" && !bootstrap
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  const sorted = latencies.toSorted((a, b) => a - b);
  await verify?.();
  console.log(
    JSON.stringify({
      mode: values.mode,
      workload: values.workload,
      iterations,
      bootstrapFixture: bootstrap
        ? {
            files: 4,
            fileBytes: bootstrapFileBytes,
            returnedBytesPerTurn: 4 * bootstrapFileBytes,
            readBoundPerFile: 2 * 1024 * 1024,
          }
        : undefined,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      elapsedMs,
      mainCpuUs: thread.user + thread.system,
      processCpuUs: cpu.user + cpu.system,
      allocatedBytes,
      heapAllocation,
      observedWorkerPopulation,
      descriptorReads,
      descriptorReadScope: bootstrap
        ? "Actual fs-safe bounded descriptor callback/sync read results, main and workers separated; bytes returned by OS, not storage-media traffic. Counts-only preload. No path probes."
        : undefined,
      allocationScope: bootstrap
        ? "Exact V8 main+worker heap allocation in allocation mode; external Buffer backing-store allocation excluded"
        : "main-thread sampled allocation; worker allocation unmeasured",
      cpuScope: "process includes worker threads; child process CPU excluded",
      cold: values.workload === "snapshot" ? undefined : cold,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      minMs: sorted[0],
      maxMs: sorted.at(-1),
      counts: filesystemCounts,
      countScope: "main-thread Node filesystem calls; worker transport counted separately",
      workerCounts: workerWork,
      hostLoad,
      hostLoadAfter,
    }),
  );
} finally {
  for (const restore of restores.toReversed()) {
    restore();
  }
  syncBuiltinESMExports();
  inspector.disconnect();
  try {
    await close();
    await drainGlobalSingletonLifecycleState("restart", { retainSharedState: true });
  } finally {
    await bootstrapObservation?.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}
