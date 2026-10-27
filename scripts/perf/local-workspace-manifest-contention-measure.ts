/**
 * Shared-reader contention from real local-workspace reconciliation, synthetic state only.
 * Prepare each revision separately (10k rows, two 1k-file projections + canonical Git tree):
 * node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-contention-measure.ts prepare .local/manifest-base
 * node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-contention-measure.ts run .local/manifest-base base timing 500
 * Repeat with candidate, alternating AB/BA. Final argument is cohorts (2 scans/cohort);
 * use 2 for smoke, 500 for >=1,000 scan and >=2,000 samples per fast read class.
 * OPENCLAW_BENCH_FILES=50 OPENCLAW_BENCH_WORKSPACES=100 reduces fixture setup for smoke;
 * use the same values for prepare/run. Default measurements retain the full shape.
 * Run allocation and cpu separately in place of timing; neither is a timing gate.
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse original-source overlay, including during prepare.
 * Accept only identical expected manifest roots/content, no filesystem scan calls on shared
 * readers, and lower fast-class queue wait. Report scan latency, total CPU/allocation across
 * host and every instrumented worker, GC, RSS/heap and host load; relocation alone is no win.
 * Gate adverse results only after matched A/A controls; never reject noisy p99 alone.
 * This is owner/pool proof, not the separate canonical Team-shaped Gateway stress harness.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { deserialize, GCProfiler } from "node:v8";
import { inflateRawSync } from "node:zlib";
import type { LocalWorkspacePreparation } from "../../src/gateway/worker-environments/local-workspace-cas.js";
import type { LocalWorkspaceStore } from "../../src/gateway/worker-environments/local-workspace-store.js";

const [mode, scratchArgument, label, instrumentation = "timing", cohortsArgument = "500"] =
  process.argv.slice(2);
assert.ok(mode === "prepare" || mode === "run");
assert.ok(scratchArgument);
assert.ok(["timing", "allocation", "cpu", "work"].includes(instrumentation));
const cohorts = Number(cohortsArgument);
assert.ok(Number.isSafeInteger(cohorts) && cohorts > 0);
const scratch = path.resolve(scratchArgument);
const canonicalRoot = path.join(scratch, "canonical");
const ids = ["synthetic-manifest-0", "synthetic-manifest-1"];
const baseCommit = "a".repeat(40);
const files = Number(process.env.OPENCLAW_BENCH_FILES ?? 1_000);
const workspaces = Number(process.env.OPENCLAW_BENCH_WORKSPACES ?? 10_000);
assert.ok(Number.isSafeInteger(files) && files > 0);
assert.ok(Number.isSafeInteger(workspaces) && workspaces >= 2);
const env = {
  ...process.env,
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: path.join(scratch, "config.json"),
  TMPDIR: path.join(scratch, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
};
Object.assign(process.env, env);
for (const directory of [scratch, env.HOME, env.TMPDIR]) {
  await fs.mkdir(directory, { recursive: true });
}
const output = path.join(scratch, "results", label ?? "prepare");
if (mode === "run") {
  assert.ok(label && /^[a-zA-Z0-9_-]+$/.test(label));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { recursive: false });
  process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR = output;
  if (instrumentation === "allocation") {
    process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = "1";
  } else if (instrumentation === "cpu") {
    process.env.OPENCLAW_BENCH_SAMPLE_CPU = "1";
  } else if (instrumentation === "work") {
    process.env.OPENCLAW_BENCH_COUNT_SQL = "1";
  }
}
if (mode === "run" || process.env.OPENCLAW_BENCH_BASELINE_DIR) {
  await import("./worker-retained-heap-preload.js");
}
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const database = openOpenClawStateDatabase({ env });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const content = (index: number) => `synthetic workspace file ${index}\n`;
const filename = (index: number) => `dir-${Math.floor(index / 100)}/file-${index}.txt`;
const projectionPath = (id: string) => path.join(scratch, "projections", id);
const distribution = (values: number[]) => {
  values.sort((a, b) => a - b);
  const at = (fraction: number) => values[Math.ceil(values.length * fraction) - 1] ?? null;
  return {
    samples: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: values.at(-1) ?? null,
  };
};

try {
  if (mode === "prepare") {
    assert.equal(await fs.stat(path.join(scratch, "fixture.json")).catch(() => null), null);
    const { createLocalWorkspaceManifestTree, localWorkspaceManifestRootReference } =
      await import("../../src/gateway/worker-environments/local-workspace-manifest-tree.js");
    const { mutateLocalWorkspaceProjection } =
      await import("../../src/gateway/worker-environments/local-workspace-store.kernel.js");
    const { prepareLocalWorkspaceTreePacks, localWorkspaceDigestBytes } =
      await import("../../src/gateway/worker-environments/local-workspace-cas.js");
    const { prepareLocalWorkspaceContentInDatabase } =
      await import("../../src/gateway/worker-environments/local-workspace-cas.kernel.js");
    const { runSqliteImmediateTransactionSync } =
      await import("../../src/infra/sqlite-transaction.js");
    const paths = Array.from({ length: files }, (_, index) => filename(index));
    const directories = Array.from(
      { length: Math.ceil(files / 100) },
      (_, index) => `dir-${index}`,
    );
    for (const root of [canonicalRoot, ...ids.map(projectionPath)]) {
      for (const directory of directories) {
        await fs.mkdir(path.join(root, directory), { recursive: true });
      }
      for (let index = 0; index < files; index++) {
        await fs.writeFile(path.join(root, filename(index)), content(index), { mode: 0o644 });
      }
    }
    execFileSync("git", ["init", "--quiet"], { cwd: canonicalRoot, env });
    execFileSync("git", ["add", "."], { cwd: canonicalRoot, env });
    const tree = createLocalWorkspaceManifestTree([
      ...directories.map((entryPath) => ({ path: entryPath, type: "directory" as const })),
      ...paths.map((entryPath, index) => ({
        path: entryPath,
        type: "file" as const,
        mode: 0o644,
        size: Buffer.byteLength(content(index)),
        sha256: digest(content(index)),
      })),
    ]);
    const expectedRoot = localWorkspaceManifestRootReference(tree, baseCommit);
    const treeRoot = localWorkspaceDigestBytes(tree.get("")!.treeRef);
    const packs = prepareLocalWorkspaceTreePacks(tree).map(
      (batch) => deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation,
    );
    runSqliteImmediateTransactionSync(database.db, () => {
      for (let index = 0; index < workspaces; index++) {
        const id = `synthetic-manifest-${index}`;
        const active = index < ids.length;
        mutateLocalWorkspaceProjection(database.db, id, {
          kind: "create",
          row: {
            worktree_id: id,
            agent_id: "main",
            session_key: `agent:main:${id}`,
            session_id: id,
            lifecycle_revision: null,
            projection_path: projectionPath(id),
            base_commit: baseCommit,
            source_paths_json: active ? JSON.stringify(paths) : "[]",
            baseline_json: null,
            baseline_ref: active ? expectedRoot : null,
            tree_root_digest: active ? treeRoot : null,
            source_paths_digest: null,
            canonical_fingerprints: null,
            projection_fingerprints: null,
            checkpoint_json: null,
            pending_ref: null,
            pending_target: null,
            journal_json: null,
            journal_pack: null,
            paused_runtimes_json: null,
            created_at_ms: 1,
          },
        });
      }
      for (const preparation of packs) {
        prepareLocalWorkspaceContentInDatabase(database.db, preparation);
      }
    });
    await fs.writeFile(
      path.join(scratch, "fixture.json"),
      JSON.stringify({ files, workspaces, expectedRoot }),
    );
    console.log(JSON.stringify({ prepared: workspaces, filesPerWorkspace: files, expectedRoot }));
  } else {
    const fixture = JSON.parse(await fs.readFile(path.join(scratch, "fixture.json"), "utf8")) as {
      files: number;
      workspaces: number;
      expectedRoot: string;
    };
    assert.equal(fixture.files, files);
    assert.equal(fixture.workspaces, workspaces);
    const { withLocalWorkspaceStore } =
      await import("../../src/gateway/worker-environments/local-workspace-store.js");
    const { executeExistingOpenClawStateRead } =
      await import("../../src/state/openclaw-state-db-readonly.js");
    const { onWorkerRequestMetrics } =
      await import("../../src/infra/worker-request-diagnostics.js");
    const { setDiagnosticsEnabledForProcess } =
      await import("../../src/infra/diagnostic-events.js");
    setDiagnosticsEnabledForProcess(true);
    const done = Promise.withResolvers<void>();
    const ready = ids.map(() => Promise.withResolvers<LocalWorkspaceStore>());
    const tasks = ids.map((worktreeId, index) =>
      withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
        ready[index]!.resolve(store);
        await done.promise;
      }).catch((error: unknown) => {
        ready[index]!.reject(error);
        throw error;
      }),
    );
    let unsubscribe: (() => void) | undefined;
    const inspector = new Session();
    inspector.connect();
    const loop = monitorEventLoopDelay({ resolution: 1 });
    const gc = new GCProfiler();
    try {
      const stores = await Promise.all(ready.map((entry) => entry.promise));
      const scan = async (store: LocalWorkspaceStore, target: "canonical" | "projection") => {
        const value = await store.manifest(store.get()!, { kind: "scan", target, canonicalRoot });
        assert.equal(value.kind, "scan");
        assert.ok(value.kind === "scan");
        assert.equal(value.resultingRoot, fixture.expectedRoot);
        assert.equal(value.currentManifestRaw, value.baseManifestRaw);
        assert.equal(value.currentManifestRef, value.baseManifestRef);
        return value;
      };
      const fastReads = {
        config: () =>
          executeExistingOpenClawStateRead(
            { env },
            { type: "config.health.read", input: undefined },
            { current: true, live: true },
          ),
        subagents: () =>
          executeExistingOpenClawStateRead(
            { env },
            { type: "subagents.runs", scope: { kind: "ids", runIds: ["synthetic-missing-run"] } },
            { current: true, live: true },
          ),
        deliveryQueue: () =>
          executeExistingOpenClawStateRead(
            { env },
            { type: "deliveryQueue.outbound", mode: "pending" },
            { current: true, live: true },
          ),
      };
      await Promise.all(stores.map((store) => scan(store, "projection")));
      await Promise.all(stores.map((store) => scan(store, "canonical")));
      await Promise.all(
        Array.from({ length: 4 }, () =>
          Promise.all(Object.values(fastReads).map((read) => read())),
        ),
      );
      type WorkerIdentity = { pid: number; threadId: number; script: string; commandPath: string };
      const workers: WorkerIdentity[] = await Promise.all(
        (await fs.readdir(output))
          .filter((file) => file.endsWith(".ready.json"))
          .map(
            async (file) =>
              JSON.parse(await fs.readFile(path.join(output, file), "utf8")) as WorkerIdentity,
          ),
      );
      assert.equal(
        workers.filter((worker) => worker.script.startsWith("openclaw-state-read.worker")).length,
        2,
      );
      let sequence = 0;
      type WorkerMeasurement = {
        ok: boolean;
        cpu: NodeJS.CpuUsage;
        allocation?: { sampledBytes: number; samples: number };
        allGc: { totalMs: number };
      };
      const command = async (worker: WorkerIdentity, operation: string) => {
        const id = `${operation}-${++sequence}`;
        const reply = worker.commandPath.replace(".command.json", `.${id}.json`);
        await fs.writeFile(`${worker.commandPath}.tmp`, JSON.stringify({ id, operation }));
        await fs.rename(`${worker.commandPath}.tmp`, worker.commandPath);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const raw = await fs.readFile(reply, "utf8").catch(() => undefined);
          if (raw) {
            const result = JSON.parse(raw) as WorkerMeasurement;
            assert.equal(result.ok, true, raw);
            return result;
          }
          await setTimeout(10);
        }
        throw new Error(`Worker ${worker.script}/${worker.threadId} ${operation} timed out`);
      };
      await Promise.all(workers.map((worker) => command(worker, "collect")));
      await inspector.post("HeapProfiler.collectGarbage");
      await Promise.all(workers.map((worker) => command(worker, "start")));
      if (instrumentation === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      } else if (instrumentation === "cpu") {
        await inspector.post("Profiler.enable");
        await inspector.post("Profiler.start");
      }
      const queued: Record<string, number[]> = {};
      const durations: Record<string, number[]> = {};
      const latency: Record<string, number[]> = {};
      unsubscribe = onWorkerRequestMetrics((kind, requestClass, phase, _depth, wait, duration) => {
        if (kind !== "stateRead") {
          return;
        }
        if (phase === "started" && wait !== undefined) {
          (queued[requestClass] ??= []).push(wait);
        }
        if (phase === "completed" && duration !== undefined) {
          (durations[requestClass] ??= []).push(duration);
        }
      });
      const timed = async (name: string, work: () => Promise<unknown>) => {
        const start = performance.now();
        await work();
        (latency[name] ??= []).push(performance.now() - start);
      };
      const hostLoad = os.loadavg();
      const initialMemory = process.memoryUsage();
      const initialCpu = process.threadCpuUsage();
      const initialProcessCpu = process.cpuUsage();
      loop.enable();
      gc.start();
      const start = performance.now();
      for (let cohort = 0; cohort < cohorts; cohort++) {
        await Promise.all([
          ...stores.map((store) =>
            timed("localWorkspace", () => scan(store, cohort % 2 ? "canonical" : "projection")),
          ),
          ...Array.from({ length: 4 }, () =>
            Object.entries(fastReads).map(([name, read]) => timed(name, read)),
          ).flat(),
        ]);
      }
      const elapsedMs = performance.now() - start;
      const cpu = process.threadCpuUsage(initialCpu);
      const processCpu = process.cpuUsage(initialProcessCpu);
      const gcProfile = gc.stop();
      loop.disable();
      const finalMemory = process.memoryUsage();
      unsubscribe();
      unsubscribe = undefined;
      const allocation =
        instrumentation === "allocation"
          ? (await inspector.post("HeapProfiler.stopSampling")).profile
          : undefined;
      const profile =
        instrumentation === "cpu" ? (await inspector.post("Profiler.stop")).profile : undefined;
      const measured = await Promise.all(workers.map((worker) => command(worker, "stop")));
      if (allocation) {
        await fs.writeFile(path.join(output, "host.heapprofile"), JSON.stringify(allocation));
      }
      if (profile) {
        await fs.writeFile(path.join(output, "host.cpuprofile"), JSON.stringify(profile));
      }
      const mainGc = distribution((gcProfile?.statistics ?? []).map((entry) => entry.cost / 1000));
      const gcByKind: Record<string, number[]> = {};
      for (const entry of gcProfile?.statistics ?? []) {
        (gcByKind[entry.gcType] ??= []).push(entry.cost / 1000);
      }
      const sampledBytes = allocation?.samples.reduce((sum, sample) => sum + sample.size, 0);
      const cpuUs = (value: NodeJS.CpuUsage) => value.user + value.system;
      const summarize = (values: Record<string, number[]>) =>
        Object.fromEntries(
          Object.entries(values).map(([name, samples]) => [name, distribution(samples)]),
        );
      const result = {
        label,
        instrumentation,
        cohorts,
        scans: cohorts * 2,
        files,
        workspaces,
        elapsedMs,
        expectedRoot: fixture.expectedRoot,
        hostLoad,
        finalHostLoad: os.loadavg(),
        latency: summarize(latency),
        queueWait: summarize(queued),
        workerDuration: summarize(durations),
        main: {
          cpu,
          processCpu,
          initialMemory,
          finalMemory,
          gc: mainGc,
          gcByKind: summarize(gcByKind),
          cpuPercent: cpuUs(cpu) / (elapsedMs * 10),
          allocation: allocation ? { sampledBytes, samples: allocation.samples.length } : undefined,
          eventLoop: {
            samples: loop.count,
            p99Ms: loop.percentile(99) / 1e6,
            maxMs: loop.max / 1e6,
          },
        },
        totals: {
          cpuUs: cpuUs(cpu) + measured.reduce((sum, worker) => sum + cpuUs(worker.cpu), 0),
          sampledAllocationBytes:
            sampledBytes === undefined
              ? undefined
              : sampledBytes +
                measured.reduce((sum, worker) => sum + (worker.allocation?.sampledBytes ?? 0), 0),
          gcMs: mainGc.totalMs + measured.reduce((sum, worker) => sum + worker.allGc.totalMs, 0),
        },
        workers: measured,
      };
      await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    } finally {
      unsubscribe?.();
      loop.disable();
      gc.stop();
      inspector.disconnect();
      done.resolve();
      await Promise.all(tasks);
    }
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
