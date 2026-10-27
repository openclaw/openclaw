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
 *
 * Uses synthetic inventory strings (or a synthetic Git checkout with --reconcile)
 * in isolated .local state; no operator state, Gateway listener or provider.
 * Forced-GC heap/old-space and weak
 * row counts distinguish retained history from allocation churn. CPU is measured
 * only around writes; allocation profiling is opt-in and must run separately.
 * The current row may survive; rows from earlier batches should be collectible.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { transformSync } from "esbuild";

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
    edits: { type: "string", default: "1000" },
  },
});
const iterations = Number(values.iterations);
const files = Number(values.files);
const batch = Number(values.batch);
assert([iterations, files, batch].every((value) => Number.isSafeInteger(value) && value > 0));
assert(values.scope === "single" || values.scope === "per-write");
assert(
  !values.reconcile || !values.allocation,
  "Use separate store allocation and reconciliation runs",
);
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const ownerFiles = [
  "src/gateway/worker-environments/local-workspace-store.ts",
  "src/gateway/worker-environments/local-workspace-publication.ts",
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
const hooks = registerHooks({
  load(url, context, next) {
    const source = url.startsWith("file:") ? preparedSources.get(fileURLToPath(url)) : undefined;
    return source !== undefined
      ? { format: "module", source, shortCircuit: true }
      : next(url, context);
  },
});
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/local-workspace-retention-"));
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
const sample = async (completed: number, phase: string) => {
  // WeakRef.deref and construction pin targets until the current JS job ends.
  await immediate();
  gc();
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
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (let i = 0; i < edits; i++) {
        fs.writeFileSync(path.join(projection, filePath(i)), `edit ${iteration}\n`);
      }
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      await withLocalWorkspaceProjection(workspaceOwner, async (state) => {
        await state.synchronize("canonical");
        rows.push(new WeakRef(state.current()));
        assert.equal(state.current().pending_ref, null);
        assert.equal(state.current().journal_json, null);
      });
      const used = process.threadCpuUsage(cpu);
      writeWindows.push({ start, end: performance.now() });
      cpuUs += used.user + used.system;
      writeMs += performance.now() - start;
      assert.equal(
        fs.readFileSync(path.join(canonical, filePath(edits - 1)), "utf8"),
        `edit ${iteration}\n`,
      );
      await sample(iteration, "reconciled");
    }
    const settled = await sample(iterations, "settled");
    assert.equal(settled.retainedRows, 0, "Settled projection rows remain reachable");
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
        cpuUs,
        writeMs,
        gc: measuredGc(),
        samples,
      }),
    );
  } else {
    await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
      store.create({
        worktree_id: id,
        agent_id: "main",
        session_key: "agent:main:synthetic-retention",
        session_id: "synthetic",
        lifecycle_revision: null,
        projection_path: path.join(root, id, "workspace"),
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
    await sample(0, "warm");
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
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
    if (values.scope === "single") {
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
        cpuUs,
        writeMs,
        sampledBytes,
        gc: measuredGc(),
        samples,
      }),
    );
  }
} finally {
  inspector.disconnect();
  gcObserver.disconnect();
  await closeOpenClawStateDatabaseAsync();
  owner.release();
  hooks.deregister();
  fs.rmSync(root, { recursive: true, force: true });
}
