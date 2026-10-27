/**
 * Exercise real workspace worker commits and check settled-row retention.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-retention.ts
 *   [--iterations 1000] [--files 100000] [--batch 100] [--allocation]
 *   [--snapshot <file>] [--scope single|per-write]
 *   [--source-dir <baseline-root>]
 * The optional source root supplies both local-workspace-store.ts and
 * local-workspace-publication.ts at their original repository-relative paths.
 * Add --reconcile --iterations 10 for real Git projection checkpoints; --files
 * creates that many files and --edits (default 1000) changes files each cycle.
 * Add --quiesce --iterations 1000 to measure real projection custody with no
 * runtime, or --quiesce --sandbox-image openclaw-sandbox:bookworm-slim
 * --iterations 20 for a private Docker runtime's actual pause/resume lifecycle.
 * Quiescence source overrides also include local-workspace-quiescence.ts. Its
 * row revision delta counts durable pause receipts; rerun --allocation separately.
 *
 * Uses synthetic inventory strings (or a synthetic Git checkout with --reconcile)
 * in isolated .local state; no operator state, Gateway listener or provider.
 * Forced-GC heap/old-space and weak
 * row counts distinguish retained history from allocation churn. CPU is measured
 * only around writes; allocation profiling is opt-in and must run separately.
 * The current row may survive; rows from earlier batches should be collectible.
 * --failure error|abort|supersede|timeout|abandon|lost-reply exercises real
 * worker failure boundaries; --retain-admissions deliberately retains finished
 * handles to test whether their callbacks still capture old workspace payloads.
 * Timeout means caller deadline cancellation, not a native admission deadline.
 * --reconcile --failure oversized preserves a sparse 64 MiB + 1 byte artifact
 * across repeated rejected checkpoints. Use ten cycles for this filesystem case.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  getHeapSpaceStatistics,
  getHeapStatistics,
  queryObjects,
  writeHeapSnapshot,
} from "node:v8";
import workerThreads, { MessagePort } from "node:worker_threads";
import { transformSync } from "esbuild";
import type { SqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";
import type { DomainScope } from "../../src/state/openclaw-state-worker-store.types.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "1000" },
    files: { type: "string", default: "100000" },
    batch: { type: "string", default: "100" },
    allocation: { type: "boolean", default: false },
    snapshot: { type: "string" },
    scope: { type: "string", default: "single" },
    "source-dir": { type: "string" },
    reconcile: { type: "boolean", default: false },
    quiesce: { type: "boolean", default: false },
    "sandbox-image": { type: "string" },
    edits: { type: "string", default: "1000" },
    failure: { type: "string" },
    "retain-admissions": { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const files = Number(values.files);
const batch = Number(values.batch);
assert([iterations, files, batch].every((value) => Number.isSafeInteger(value) && value > 0));
assert(values.scope === "single" || values.scope === "per-write");
assert(!(values.reconcile && values.quiesce), "Choose reconciliation or quiescence");
assert(!(values.failure && values.quiesce), "Choose failure or quiescence");
assert(!values["sandbox-image"] || values.quiesce, "--sandbox-image requires --quiesce");
assert(
  values.failure === undefined ||
    ["error", "abort", "supersede", "timeout", "abandon", "lost-reply", "oversized"].includes(
      values.failure,
    ),
);
assert(
  !values.failure || (!values.allocation && (values.failure === "oversized") === values.reconcile),
);
assert(
  !values.reconcile || !values.allocation,
  "Use separate store allocation and reconciliation runs",
);
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const ownerFiles = [
  "src/gateway/worker-environments/local-workspace-store.ts",
  "src/gateway/worker-environments/local-workspace-publication.ts",
  "src/infra/sqlite-worker-operation-admission.ts",
  ...(values.quiesce ? ["src/agents/sandbox/local-workspace-quiescence.ts"] : []),
];
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const preparedSources = new Map<string, string>();
const sources = ownerFiles.map((file) => {
  const source = fs.readFileSync(path.join(values["source-dir"] ?? sourceRoot, file), "utf8");
  preparedSources.set(
    path.join(sourceRoot, file),
    transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
  );
  return { file, hash: createHash("sha256").update(source).digest("hex") };
});
const ownerHash = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
const workerStorePath = path.join(sourceRoot, "src/state/openclaw-state-worker-store.ts");
const probeKey = "__localWorkspaceRetentionProbe";
const hooks = registerHooks({
  load(url, context, next) {
    if (values.failure && url.startsWith("file:") && fileURLToPath(url) === workerStorePath) {
      const original = new URL(url);
      if (!original.searchParams.has("retentionOriginal")) {
        original.searchParams.set("retentionOriginal", "1");
        // Same operation/execute boundary as sqliteWorkerOwnerProbe.command in tests.
        return {
          format: "module",
          source: `
            export * from ${JSON.stringify(original.href)};
            import { runOpenClawStateWorkerOperation as run } from ${JSON.stringify(original.href)};
            export function runOpenClawStateWorkerOperation(context, operation, options) {
              const probe = globalThis[${JSON.stringify(probeKey)}];
              const wrapped = options?.createAdmission ? {
                ...options,
                createAdmission(operation) {
                  const result = options.createAdmission(operation);
                  probe.admission(result.admission);
                  return result;
                }
              } : options;
              return run(context, scope => operation({
                execute: (command, options) => probe.command(command, options, scope)
              }), wrapped);
            }
          `,
          shortCircuit: true,
        };
      }
    }
    const source = url.startsWith("file:") ? preparedSources.get(fileURLToPath(url)) : undefined;
    return source !== undefined
      ? { format: "module", source, shortCircuit: true }
      : next(url, context);
  },
});
const ports = new Set<WeakRef<MessagePort>>();
const NativeMessageChannel = workerThreads.MessageChannel;
if (values.failure) {
  workerThreads.MessageChannel = class extends NativeMessageChannel {
    constructor() {
      super();
      for (const port of [this.port1, this.port2]) {
        const reference = new WeakRef(port);
        ports.add(reference);
        port.once("close", () => ports.delete(reference));
      }
    }
  };
  syncBuiltinESMExports();
}
type Fault = {
  controller: AbortController;
  revoked: boolean;
  observed: boolean;
  ready: ReturnType<typeof Promise.withResolvers<void>>;
};
let fault: Fault | undefined;
const payloads: WeakRef<object>[] = [];
const admissions: WeakRef<SqliteWorkerOperationAdmission>[] = [];
const heldAdmissions: SqliteWorkerOperationAdmission[] = [];
const observedAdmissions = new WeakSet<SqliteWorkerOperationAdmission>();
let createdAdmissions = 0;
let finishCalls = 0;
let finishedAdmissions = 0;
let intercepted = 0;
Object.assign(globalThis, {
  [probeKey]: {
    admission(admission: SqliteWorkerOperationAdmission) {
      const current = fault;
      if (!current) {
        return;
      }
      if (observedAdmissions.has(admission)) {
        current.ready.resolve();
        return;
      }
      observedAdmissions.add(admission);
      createdAdmissions++;
      const finish = admission.finish.bind(admission);
      let finished = false;
      admission.finish = () => {
        finishCalls++;
        finish();
        if (!finished) {
          finished = true;
          finishedAdmissions++;
        }
      };
      admissions.push(new WeakRef(admission));
      if (values["retain-admissions"]) {
        heldAdmissions.push(admission);
      }
      admission.observeRequests((request) => {
        if (request.stage === "commit" && !current.observed) {
          current.observed = true;
          if (values.failure === "abort") {
            current.controller.abort(new Error("Synthetic commit-stage cancellation"));
          } else if (values.failure === "supersede") {
            current.revoked = true;
          }
        }
      });
      current.ready.resolve();
    },
    async command(
      command: Parameters<DomainScope["execute"]>[0],
      options: Parameters<DomainScope["execute"]>[1],
      scope: DomainScope,
    ) {
      const current = fault;
      if (!current || command.type !== "localWorkspace.mutate") {
        return scope.execute(command, options);
      }
      intercepted++;
      if (values.failure === "timeout") {
        const signal = AbortSignal.timeout(1);
        // Keep this caller deadline's timer alive even when every worker port is unref'd.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2);
        });
        assert(signal.aborted);
        return scope.execute(command, { ...options, signal });
      }
      const result = scope.execute(command, { ...options, signal: current.controller.signal });
      if (values.failure === "abandon") {
        void result.catch(() => undefined);
        await current.ready.promise;
        throw new Error("Synthetic caller abandoned the accepted worker result");
      }
      const value = await result;
      if (values.failure === "lost-reply") {
        throw new Error("Synthetic reply loss after native commit");
      }
      return value;
    },
  },
});
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/local-workspace-retention-"));
if (values["sandbox-image"] && !process.env.DOCKER_CONFIG) {
  process.env.DOCKER_CONFIG = path.join(process.env.HOME!, ".docker");
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  HOME: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.ts");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.ts");
const { withLocalWorkspaceStore } =
  await import("../../src/gateway/worker-environments/local-workspace-store.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const owner = acquireGatewayStateOwner({
  databasePath: path.join(root, "state", "openclaw.sqlite"),
  payload: {
    pid: process.pid,
    role: "gateway",
    createdAt: new Date().toISOString(),
    configPath: path.join(root, "openclaw.json"),
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
const id = randomUUID();
const sourcePaths = JSON.stringify(
  Array.from({ length: files }, (_, i) => `src/directory-${Math.floor(i / 100)}/file-${i}.ts`),
);
const rows: WeakRef<object>[] = [];
const samples: Record<string, unknown>[] = [];
const inspector = new Session();
const writeWindows: Array<{ start: number; end: number }> = [];
const collections: Array<{ start: number; duration: number }> = [];
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    collections.push({ start: entry.startTime, duration: entry.duration });
  }
});
gcObserver.observe({ entryTypes: ["gc"] });
const measuredGc = () => {
  const selected = collections.filter((entry) =>
    writeWindows.some((window) => entry.start >= window.start && entry.start < window.end),
  );
  return {
    count: selected.length,
    totalMs: selected.reduce((sum, entry) => sum + entry.duration, 0),
    maxMs: Math.max(0, ...selected.map((entry) => entry.duration)),
  };
};
let cpuUs = 0;
let writeMs = 0;
let sandboxContainer: string | undefined;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
const sample = async (completed: number, phase: string) => {
  // WeakRef.deref and construction pin targets until the current JS job ends.
  await immediate();
  gc();
  for (const reference of ports) {
    if (!reference.deref()) {
      ports.delete(reference);
    }
  }
  await immediate();
  gc();
  const memory = process.memoryUsage();
  const entry = {
    phase,
    completed,
    heapUsed: getHeapStatistics().used_heap_size,
    oldSpace: getHeapSpaceStatistics()
      .filter(
        (space) => space.space_name === "old_space" || space.space_name === "large_object_space",
      )
      .reduce((sum, space) => sum + space.space_used_size, 0),
    rss: memory.rss,
    external: memory.external,
    retainedRows: rows.reduce((sum, row) => sum + (row.deref() ? 1 : 0), 0),
    trackedRows: rows.length,
    ...(values.failure
      ? {
          retainedPayloads: payloads.filter((value) => value.deref()).length,
          retainedAdmissions: admissions.filter((value) => value.deref()).length,
          deliberatelyHeldAdmissions: heldAdmissions.length,
          createdAdmissions,
          finishCalls,
          finishedAdmissions,
          liveObservedPorts: ports.size,
          reachablePortWrappers: queryObjects(MessagePort, { format: "count" }),
        }
      : {}),
    load: loadavg(),
  };
  samples.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
};
try {
  if (values.reconcile) {
    const edits = Number(values.edits);
    assert(Number.isSafeInteger(edits) && edits > 0 && edits <= files);
    Object.assign(process.env, {
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
    const { withLocalWorkspaceProjection } =
      await import("../../src/gateway/worker-environments/local-workspace-projection.ts");
    const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
    setRuntimeConfigSnapshot({});
    const repo = path.join(root, "repo");
    const canonical = path.join(root, "canonical");
    fs.mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "config", "user.name", "Synthetic fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    const filePath = (index: number) => `dir-${Math.floor(index / 1000)}/file-${index}.txt`;
    for (let i = 0; i < files; i++) {
      if (i % 1000 === 0) {
        fs.mkdirSync(path.dirname(path.join(repo, filePath(i))));
      }
      fs.writeFileSync(path.join(repo, filePath(i)), "initial\n");
    }
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Synthetic workspace");
    git(repo, "worktree", "add", "--quiet", "-b", "synthetic", canonical);
    const sessionKey = "agent:main:synthetic-retention";
    const workspaceOwner = {
      agentId: "main",
      sessionKey,
      sessionId: "synthetic",
      lifecycleRevision: null,
      assertCurrent: () => {},
      worktree: {
        id,
        name: "synthetic",
        repoFingerprint: "synthetic",
        repoRoot: repo,
        path: canonical,
        branch: "synthetic",
        baseRef: "main",
        ownerKind: "session" as const,
        ownerId: sessionKey,
        createdAt: 1,
        lastActiveAt: 1,
      },
    };
    console.log(JSON.stringify({ phase: "fixture", files, edits }));
    const projection = await withLocalWorkspaceProjection(workspaceOwner, (state) =>
      state.prepare(),
    );
    await sample(0, "prepared");
    let recoveryPorts: number | undefined;
    const artifact = path.join(projection, ".artifacts", "oversized-package.tgz");
    const oversizedBytes = 64 * 1024 * 1024 + 1;
    let pendingRef: string | null | undefined;
    if (values.failure === "oversized") {
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, "preserved synthetic artifact\n");
      fs.truncateSync(artifact, oversizedBytes);
    }
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (let i = 0; i < edits; i++) {
        fs.writeFileSync(path.join(projection, filePath(i)), `edit ${iteration}\n`);
      }
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      const reconcile = withLocalWorkspaceProjection(workspaceOwner, async (state) => {
        try {
          await state.synchronize("canonical");
        } finally {
          rows.push(new WeakRef(state.current()));
          if (values.failure === "oversized") {
            pendingRef ??= state.current().pending_ref;
            assert(pendingRef);
            assert.equal(state.current().pending_ref, pendingRef);
            assert.equal(state.current().pending_target, "canonical");
          } else {
            assert.equal(state.current().pending_ref, null);
          }
          assert.equal(state.current().journal_json, null);
        }
      });
      if (values.failure === "oversized") {
        await assert.rejects(
          reconcile,
          /Cloud workspace result is too large:.*oversized-package\.tgz/,
        );
        assert.equal(fs.statSync(artifact).size, oversizedBytes);
      } else {
        await reconcile;
      }
      const used = process.threadCpuUsage(cpu);
      writeWindows.push({ start, end: performance.now() });
      cpuUs += used.user + used.system;
      writeMs += performance.now() - start;
      assert.equal(
        fs.readFileSync(path.join(canonical, filePath(edits - 1)), "utf8"),
        values.failure === "oversized" ? "initial\n" : `edit ${iteration}\n`,
      );
      const observed = await sample(
        iteration,
        values.failure === "oversized" ? "oversized" : "reconciled",
      );
      if (values.failure === "oversized") {
        // Recovery guidance first loads its own filesystem/read workers.
        recoveryPorts ??= observed.liveObservedPorts;
        assert.equal(observed.liveObservedPorts, recoveryPorts, "Recovery ports grew after warmup");
      }
    }
    const settled = await sample(iterations, "settled");
    assert.equal(settled.retainedRows, 0, "Settled projection rows remain reachable");
    if (values.failure) {
      assert.equal(
        settled.liveObservedPorts,
        recoveryPorts,
        "Live ports did not return to their warm plateau",
      );
    }
    if (values.snapshot) {
      writeHeapSnapshot(path.resolve(values.snapshot));
    }
    console.log(
      JSON.stringify({
        ownerHash,
        sources,
        iterations,
        files,
        edits,
        failure: values.failure,
        cpuUs,
        writeMs,
        gc: measuredGc(),
        samples,
      }),
    );
  } else {
    const projectionPath = values.quiesce
      ? path.join(fs.realpathSync(root), "worktree-projections", id, "workspace")
      : path.join(root, id, "workspace");
    if (values.quiesce) {
      fs.mkdirSync(projectionPath, { recursive: true });
    }
    await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
      store.create({
        worktree_id: id,
        agent_id: "main",
        session_key: "agent:main:synthetic-retention",
        session_id: "synthetic",
        lifecycle_revision: null,
        projection_path: projectionPath,
        base_commit: "a".repeat(40),
        source_paths_json: sourcePaths,
        baseline_json: null,
        baseline_ref: null,
        checkpoint_json: null,
        pending_ref: null,
        pending_target: null,
        journal_json: null,
        journal_pack: null,
        paused_runtimes_json: null,
        created_at_ms: 1,
      }),
    );
    if (values.failure) {
      const warm = await sample(0, "warm");
      for (let index = 1; index <= iterations; index++) {
        const current: Fault = {
          controller: new AbortController(),
          revoked: false,
          observed: false,
          ready: Promise.withResolvers<void>(),
        };
        const accepted = ["lost-reply", "abandon", "abort"].includes(values.failure);
        let failed = false;
        try {
          await withLocalWorkspaceStore(
            {
              worktreeId: id,
              assertCurrent: () => {
                if (current.revoked) {
                  throw new Error("Synthetic workspace owner superseded");
                }
              },
            },
            async (store) => {
              const previous = store.get()!;
              rows.push(new WeakRef(previous));
              const patch = { checkpoint_json: `{"iteration":${index},"paths":${sourcePaths}}` };
              payloads.push(new WeakRef(patch));
              fault = current;
              try {
                const result = await store.update(
                  values.failure === "error" ? { ...previous, revision: -1 } : previous,
                  patch,
                );
                assert(accepted, "The refused write unexpectedly succeeded");
                assert.equal(result.revision, index);
                assert.equal(result.checkpoint_json, patch.checkpoint_json);
              } finally {
                fault = undefined;
              }
            },
          );
        } catch (error) {
          if (accepted) {
            throw error;
          }
          assert(error instanceof Error);
          if (values.failure === "error") {
            assert.match(error.message, /Local workspace binding changed/);
          } else if (values.failure === "supersede") {
            assert.match(error.message, /Synthetic workspace owner superseded/);
          } else if (values.failure === "timeout") {
            assert.match(error.message, /timeout/i);
          } else if (values.failure === "abort") {
            assert.match(error.message, /Synthetic commit-stage cancellation|abort|cancel/i);
          }
          failed = true;
        }
        assert.equal(failed, !accepted);
        if (values.failure === "abort" || values.failure === "supersede") {
          assert(current.observed, "Failure missed native commit admission");
        }
        if (index % batch === 0) {
          await sample(index, values.failure);
        }
      }
      await withLocalWorkspaceStore({ worktreeId: id }, async (store) => {
        assert.equal(
          store.get()!.revision,
          ["lost-reply", "abandon", "abort"].includes(values.failure!) ? iterations : 0,
        );
      });
      const settled = await sample(iterations, "settled");
      console.log(
        JSON.stringify({
          ownerHash,
          sources,
          failure: values.failure,
          iterations,
          files,
          intercepted,
          samples,
        }),
      );
      assert.equal(intercepted, iterations);
      assert.equal(createdAdmissions, values.failure === "timeout" ? 0 : iterations);
      assert.equal(finishedAdmissions, createdAdmissions, "Worker admissions skipped finish");
      assert.equal(
        settled.liveObservedPorts,
        warm.liveObservedPorts,
        "Live ports did not return to their warm plateau",
      );
      assert.equal(settled.retainedRows, 0, "Finished handles retain prior workspace rows");
      assert.equal(
        settled.retainedPayloads,
        0,
        "Finished handles retain workspace mutation payloads",
      );
    } else {
      if (values["sandbox-image"]) {
        const { updateRegistry } = await import("../../src/agents/sandbox/registry.ts");
        const containerName = `openclaw-perf-quiesce-${id}`;
        sandboxContainer = docker(
          "create",
          "--name",
          containerName,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--mount",
          `type=bind,src=${projectionPath},dst=/workspace`,
          values["sandbox-image"],
          "sleep",
          "infinity",
        );
        docker("start", sandboxContainer);
        await updateRegistry({
          containerName,
          backendId: "docker",
          sessionKey: "agent:main:synthetic-retention",
          workspaceDir: projectionPath,
          workspaceSource: "managed-worktree",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: values["sandbox-image"],
        });
      }
      if (!values.quiesce) {
        await sample(0, "warm");
      }
      const startAllocation = async () => {
        if (values.allocation) {
          inspector.connect();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32768,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
      };
      if (!values.quiesce) {
        await startAllocation();
      }
      const update = async (
        store: Parameters<Parameters<typeof withLocalWorkspaceStore>[1]>[0],
        index: number,
      ) => {
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        const row = await store.update(store.get()!, {
          checkpoint_json: `{"iteration":${index},"paths":${sourcePaths}}`,
        });
        const used = process.threadCpuUsage(cpu);
        writeWindows.push({ start, end: performance.now() });
        cpuUs += used.user + used.system;
        writeMs += performance.now() - start;
        rows.push(new WeakRef(row));
      };
      let receiptWrites: number | undefined;
      const phaseMs: Record<string, number> = {};
      if (values.quiesce) {
        const { withLocalWorkspaceProjection } =
          await import("../../src/gateway/worker-environments/local-workspace-projection.ts");
        const { withWorktreePreparationTiming } =
          await import("../../src/agents/worktrees/preparation-timing.ts");
        const { withDiagnosticsTimelineObserver } =
          await import("../../src/infra/diagnostics-timeline.ts");
        const workspaceOwner = {
          agentId: "main",
          sessionKey: "agent:main:synthetic-retention",
          sessionId: "synthetic",
          lifecycleRevision: null,
          assertCurrent: owner.assertCurrent,
          worktree: {
            id,
            name: "synthetic",
            repoFingerprint: "synthetic",
            repoRoot: root,
            path: root,
            branch: "synthetic",
            baseRef: "HEAD",
            ownerKind: "session" as const,
            ownerId: "agent:main:synthetic-retention",
            createdAt: 1,
            lastActiveAt: 1,
          },
        };
        const quiesce = () =>
          withLocalWorkspaceProjection(workspaceOwner, async (state) => {
            rows.push(new WeakRef(state.current()));
          });
        // Warm imports, state readers and Docker before the measured lifecycle.
        await quiesce();
        await sample(0, "warm");
        const before = await withLocalWorkspaceStore(
          { worktreeId: id },
          async (store) => store.get()!.revision,
        );
        await startAllocation();
        await withDiagnosticsTimelineObserver(
          (name, _attributes, durationMs) => {
            if (durationMs !== undefined && name.startsWith("worktree.managed.")) {
              phaseMs[name] = durationMs;
            }
            return undefined;
          },
          () =>
            withWorktreePreparationTiming("managed", async () => {
              for (let i = 1; i <= iterations; i++) {
                const cpu = process.threadCpuUsage();
                const start = performance.now();
                await quiesce();
                const end = performance.now();
                const used = process.threadCpuUsage(cpu);
                writeWindows.push({ start, end });
                cpuUs += used.user + used.system;
                writeMs += end - start;
                if (i % batch === 0) {
                  await sample(i, "quiesced");
                }
              }
            }),
        );
        receiptWrites = await withLocalWorkspaceStore({ worktreeId: id }, async (store) => {
          const row = store.get()!;
          assert.equal(row.paused_runtimes_json, null);
          return row.revision - before;
        });
        if (sandboxContainer) {
          assert.equal(
            docker("inspect", "-f", "{{.State.Running}} {{.State.Paused}}", sandboxContainer),
            "true false",
            "Measured sandbox did not resume",
          );
        }
      } else if (values.scope === "single") {
        await withLocalWorkspaceStore({ worktreeId: id }, async (store) => {
          for (let i = 1; i <= iterations; i++) {
            await update(store, i);
            if (i % batch === 0) {
              await sample(i, "active");
            }
          }
        });
      } else {
        for (let i = 1; i <= iterations; i++) {
          await withLocalWorkspaceStore({ worktreeId: id }, (store) => update(store, i));
          if (i % batch === 0) {
            await sample(i, "released");
          }
        }
      }
      let sampledBytes: number | undefined;
      if (values.allocation) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        sampledBytes = 0;
        const pending = [profile.head];
        while (pending.length) {
          const node = pending.pop()!;
          sampledBytes += node.selfSize;
          pending.push(...node.children);
        }
        inspector.disconnect();
      }
      const settled = await sample(iterations, "settled");
      assert.equal(settled.retainedRows, 0, "Settled workspace rows remain reachable");
      if (values.snapshot) {
        writeHeapSnapshot(path.resolve(values.snapshot));
      }
      console.log(
        JSON.stringify({
          iterations,
          ownerHash,
          sources,
          files,
          scope: values.scope,
          quiesce: values.quiesce,
          sandboxImage: values["sandbox-image"],
          receiptWrites,
          phaseMs,
          cpuUs,
          writeMs,
          sampledBytes,
          gc: measuredGc(),
          samples,
        }),
      );
    }
  }
} finally {
  try {
    if (sandboxContainer) {
      docker("rm", "--force", sandboxContainer);
    }
  } finally {
    inspector.disconnect();
    gcObserver.disconnect();
    await closeOpenClawStateDatabaseAsync();
    owner.release();
    hooks.deregister();
    workerThreads.MessageChannel = NativeMessageChannel;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
