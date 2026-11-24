/**
 * Measure the real sandbox -> workspace projection -> state-owner assertion cascade.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-assertion-measure.mjs
 *   [--source-dir <baseline-source-root>] [--iterations 2000]
 *
 * The optional root supplies exact context/store/projection source snapshots; all
 * other modules retain their canonical identity. Run alternating base/candidate.
 * One real retained session/projection among 2k sessions and 62k admitted paths
 * exercises shared authority (no session scan). Use --iterations 10000 for the fs-safe mutation pass, which
 * disables fsync to measure mutation authority rather than storage durability.
 * CPU, sampled allocation and filesystem work counts run separately. No Gateway,
 * provider, container, Git checkout or operator state is used. State is removed.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { root as safeRoot } from "@openclaw/fs-safe/root";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    "assertions-per-second": { type: "string", default: "70" },
  },
});
const iterations = Number(values.iterations);
const rate = Number(values["assertions-per-second"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isFinite(rate) && rate > 0);
assert(global.gc, "Run with --expose-gc");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  "src/infra/gateway-state-owner.ts",
  "src/agents/sandbox/state-owner.ts",
  "src/agents/sandbox/context.ts",
  "src/gateway/worker-environments/local-workspace-store.ts",
  "src/gateway/worker-environments/local-workspace-projection.ts",
  "src/gateway/worker-environments/local-workspace-state.ts",
];
const sources = new Map(
  files.map((file) => {
    const source = fs.readFileSync(path.join(values["source-dir"] ?? sourceRoot, file), "utf8");
    return [
      path.join(sourceRoot, file),
      {
        file,
        hash: createHash("sha256").update(source).digest("hex"),
        code: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      },
    ];
  }),
);
const hooks = registerHooks({
  load(url, context, next) {
    const source = url.startsWith("file:") && sources.get(fileURLToPath(url));
    return source
      ? { format: "module", source: source.code, shortCircuit: true }
      : next(url, context);
  },
});
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/workspace-assertion-"));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  HOME: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.ts");
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.ts");
const { registerSandboxBackend } = await import("../../src/agents/sandbox/backend.ts");
const { resolveSandboxContext } = await import("../../src/agents/sandbox/context.ts");
const { resolvePreparedSandboxRuntimeStatus } =
  await import("../../src/agents/sandbox/runtime-status.ts");
const { withLocalWorkspaceStore } =
  await import("../../src/gateway/worker-environments/local-workspace-store.ts");
const { withLocalWorkspaceProjection, resolveLocalWorkspaceOwner } =
  await import("../../src/gateway/worker-environments/local-workspace-projection.ts");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.ts");
const { replaceSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry.ts");
const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.ts");
const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.ts");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.ts");
await import("../../src/agents/sandbox/local-workspace-quiescence.ts");
const databasePath = path.join(root, "state", "openclaw.sqlite");
const owner = acquireGatewayStateOwner({
  databasePath,
  payload: {
    pid: process.pid,
    role: "gateway",
    createdAt: new Date().toISOString(),
    configPath: path.join(root, "openclaw.json"),
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
let runtimeAssert;
const unregister = registerSandboxBackend("assertion-bench", async (params) => {
  runtimeAssert = params.assertRuntimeCurrent;
  return {
    id: "assertion-bench",
    runtimeId: "synthetic",
    runtimeLabel: "Synthetic",
    workdir: "/workspace",
    buildExecSpec() {
      throw new Error("No execution");
    },
    runShellCommand() {
      throw new Error("No execution");
    },
  };
});
const inspector = new Session();
try {
  const config = {
    agents: {
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          backend: "assertion-bench",
          workspaceAccess: "rw",
          prune: { idleHours: 0, maxAgeDays: 0 },
        },
      },
    },
    skills: { load: { watch: false } },
  };
  const sessionKey = "agent:main:subagent:assertion-bench";
  await resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir: path.join(root, "workspace"),
    preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
      cfg: config,
      sessionKey,
      preparedSessionEntry: null,
    }),
  });
  assert(runtimeAssert);
  const id = randomUUID();
  const row = {
    worktree_id: id,
    agent_id: "main",
    session_key: sessionKey,
    session_id: "synthetic",
    lifecycle_revision: null,
    projection_path: path.join(fs.realpathSync(root), "worktree-projections", id, "workspace"),
    base_commit: "a".repeat(40),
    source_paths_json: JSON.stringify(Array.from({ length: 62000 }, (_, i) => `src/file-${i}.ts`)),
    baseline_json: null,
    baseline_ref: null,
    tree_root_digest: null,
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
  };
  await withLocalWorkspaceStore({ worktreeId: id }, (store) => store.create(row));
  const workspaceOwner = {
    agentId: "main",
    sessionKey,
    sessionId: "synthetic",
    lifecycleRevision: null,
    assertCurrent: runtimeAssert,
    workerAuthority: { assertCurrent: runtimeAssert },
    worktree: {
      id,
      name: "synthetic",
      repoFingerprint: "synthetic",
      repoRoot: root,
      path: root,
      branch: "synthetic",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  await seedTeamShapeSessions({
    stateDir: root,
    sessions: 2000,
    retainedRuns: 0,
    seed: 2146,
    now: 1,
    transcriptBytes: 0,
  });
  await insertRegistryWorktree(process.env, workspaceOwner.worktree);
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: row.session_id,
      updatedAt: 1,
      worktree: { id, branch: workspaceOwner.worktree.branch, repoRoot: root },
    },
  );
  using selectedOwner = await resolveLocalWorkspaceOwner({
    cfg: config,
    agentId: "main",
    sessionKey,
    assertCurrent: runtimeAssert,
  });
  assert(selectedOwner);
  const results = [];
  await withLocalWorkspaceProjection(
    selectedOwner,
    async (state) => {
      fs.mkdirSync(row.projection_path, { recursive: true });
      const workspace = await safeRoot(row.projection_path, {
        assertBeforeMutation: state.current,
        durable: false,
      });
      for (const [name, run] of [
        ["runtime", runtimeAssert],
        ["projection", state.current],
        ["worker", state.workerAuthority.assertCurrent],
        ["fs-safe", () => workspace.write("probe.txt", "synthetic\n")],
      ]) {
        console.log(`Measuring ${name}`);
        const repeat = async (count) => {
          for (let i = 0; i < count; i++) {
            await run();
            if (i % 25 === 24) {
              await immediate();
            }
          }
        };
        for (let i = 0; i < 100; i++) {
          await run();
        }
        let rootStats = 0;
        let realpaths = 0;
        const original = fs.lstatSync;
        const originalRealpath = fs.realpathSync.native;
        fs.realpathSync.native = function (...args) {
          realpaths++;
          return originalRealpath.apply(this, args);
        };
        fs.lstatSync = function (...args) {
          if (args[0] === owner.path) {
            rootStats++;
          }
          return original.apply(this, args);
        };
        syncBuiltinESMExports();
        try {
          for (let i = 0; i < 100; i++) {
            await run();
          }
        } finally {
          fs.lstatSync = original;
          fs.realpathSync.native = originalRealpath;
          syncBuiltinESMExports();
        }
        global.gc();
        await immediate();
        const cpu = process.threadCpuUsage();
        const start = performance.now();
        await repeat(iterations);
        const durationMs = performance.now() - start;
        const used = process.threadCpuUsage(cpu);
        inspector.connect();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        await repeat(iterations);
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        inspector.disconnect();
        let allocated = 0;
        const pending = [profile.head];
        while (pending.length) {
          const node = pending.pop();
          allocated += node.selfSize;
          pending.push(...node.children);
        }
        results.push({
          name,
          iterations,
          rootStatsPerOperation: rootStats / 100,
          realpathsPerOperation: realpaths / 100,
          rootStatsPerSecond: ((rootStats / 100) * iterations * 1000) / durationMs,
          mainCpuUsPerOperation: (used.user + used.system) / iterations,
          durationMs,
          sampledBytesPerOperation: allocated / iterations,
          normalizedMainCpuMsPerSecond: (((used.user + used.system) / iterations) * rate) / 1000,
          normalizedBytesPerSecond: (allocated / iterations) * rate,
        });
        await immediate();
      }
    },
    { provision: true },
  );
  console.log(
    JSON.stringify({
      sources: [...sources.values()].map(({ file, hash }) => ({ file, hash })),
      load: loadavg(),
      shape: { sessions: 2001, admittedPaths: 62000, assertionsPerSecond: rate },
      results,
    }),
  );
} finally {
  inspector.disconnect();
  unregister();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  owner.release();
  hooks.deregister();
  fs.rmSync(root, { recursive: true, force: true });
}
