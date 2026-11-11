/**
 * Measure base-refresh reservations through projectionOperations and the real SQLite writer.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-refresh-measure.ts
 *   --output .local/refresh-candidate --iterations 2048 --workspaces 128 --active 16 --paths 1000
 * Add --revision <base-sha> for the original local-workspace-state.ts producer.
 * Run fresh processes in AB/BA order, with --instrument allocation in separate passes.
 * Source hooks supply an already-read synthetic Git snapshot and count writer commands;
 * they do not replace the reservation producer, store, authority, or SQLite operations.
 * Stop after its real reservation commit, then clear that receipt through store.update.
 * Timing/allocation include acquisition and this reset; command counts separate them.
 * Idle rows receive one acquisition each. Active rows rotate through unchanged-admission
 * refreshes. Counts/minute use the declared --refreshes-per-minute rate, not elapsed time.
 * This owner microbenchmark has no Gateway clients/model turns and makes no Team claims.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    iterations: { type: "string", default: "2048" },
    workspaces: { type: "string", default: "128" },
    active: { type: "string", default: "16" },
    paths: { type: "string", default: "1000" },
    instrument: { type: "string", default: "timing" },
    "refreshes-per-minute": { type: "string", default: "30" },
  },
});
assert(values.output, "--output must name a new synthetic-state directory");
assert(["timing", "allocation"].includes(values.instrument!));
const iterations = Number(values.iterations);
const workspaces = Number(values.workspaces);
const active = Number(values.active);
const paths = Number(values.paths);
const refreshesPerMinute = Number(values["refreshes-per-minute"]);
for (const value of [iterations, workspaces, active, paths, refreshesPerMinute]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(active <= workspaces);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(values.output);
fs.mkdirSync(output);
for (const name of ["home", "tmp", "state"]) {
  fs.mkdirSync(path.join(output, name));
}
const producer = "src/gateway/worker-environments/local-workspace-state.ts";
const producerSource = values.revision
  ? execFileSync("git", ["show", `${values.revision}:${producer}`], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
    })
  : fs.readFileSync(path.join(root, producer), "utf8");
const admittedPaths = Array.from(
  { length: paths },
  (_, index) => `.artifacts/build-cache-inputs/input-${index}.json`,
);
const sourcePaths = JSON.stringify([
  ...admittedPaths,
  ".artifacts",
  ".artifacts/build-cache-inputs",
]);
const snapshot = {
  current: { entries: admittedPaths.map((entryPath) => ({ path: entryPath })) },
};
type Phase = "setup" | "idle" | "acquisition" | "refresh" | "reset";
let phase: Phase = "setup";
const counts: Record<Phase, Record<string, number>> = {
  setup: {},
  idle: {},
  acquisition: {},
  refresh: {},
  reset: {},
};
Object.assign(globalThis, {
  __workspaceRefreshSnapshot: () => snapshot,
  __workspaceRefreshCommand: (command: string) => {
    counts[phase][command] = (counts[phase][command] ?? 0) + 1;
    return command;
  },
});
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    let code: string | undefined;
    if (relative === producer) {
      code = producerSource;
    } else if (relative === "src/gateway/worker-environments/workspace-result-staging.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "  const { objectsByPath, ...snapshot } = await loadStagedWorkspaceManifest(";
      assert(code.includes(anchor), "Staged snapshot hook must match its owner");
      code = code.replace(anchor, "  return globalThis.__workspaceRefreshSnapshot();\n" + anchor);
    } else if (relative === "src/gateway/worker-environments/local-workspace-store.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      for (const operation of ["pruneLegacy", "prepare", "mutate"]) {
        const anchor = `type: "localWorkspace.${operation}",`;
        assert(code.includes(anchor), `Writer hook must find ${operation}`);
        code = code.replaceAll(
          anchor,
          `type: globalThis.__workspaceRefreshCommand("localWorkspace.${operation}"),`,
        );
      }
    }
    return code === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(output, "state"), TMPDIR: path.join(output, "tmp") },
});
fs.writeFileSync(configPath, JSON.stringify(BASE_GATEWAY_BENCH_CONFIG));
const { projectionOperations } =
  await import("../../src/gateway/worker-environments/local-workspace-state.js");
const { withLocalWorkspaceStore } =
  await import("../../src/gateway/worker-environments/local-workspace-store.js");
const { localWorkspaceProjectionPath } =
  await import("../../src/gateway/worker-environments/local-workspace-checkout.js");
const { createLocalWorkspaceManifestTree, localWorkspaceManifestRootReference } =
  await import("../../src/gateway/worker-environments/local-workspace-manifest-tree.js");
const { localWorkspaceDigestBytes, prepareLocalWorkspaceTreePacks } =
  await import("../../src/gateway/worker-environments/local-workspace-cas.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
const { executeOpenClawStateWorker } =
  await import("../../src/state/openclaw-state-worker-store.js");
const state = await import("../../src/state/openclaw-state-db.js");
(await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(
  BASE_GATEWAY_BENCH_CONFIG,
);
state.openOpenClawStateDatabase();
const baseCommit = "a".repeat(40);
const tree = createLocalWorkspaceManifestTree([]);
const treeDigest = localWorkspaceDigestBytes(tree.get("")!.treeRef);
const baselineRef = localWorkspaceManifestRootReference(tree, baseCommit);
const owners: LocalWorkspaceOwner[] = Array.from({ length: workspaces }, (_, index) => ({
  agentId: "main",
  sessionKey: `agent:main:workspace:synthetic-${index}`,
  sessionId: `synthetic-${index}`,
  lifecycleRevision: null,
  env: process.env,
  assertCurrent() {},
  worktree: {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `synthetic-${index}`,
    repoFingerprint: "synthetic",
    repoRoot: path.join(output, "repository"),
    path: path.join(output, `canonical-${index}`),
    branch: `synthetic-${index}`,
    baseRef: "main",
    ownerKind: "session",
    ownerId: `agent:main:workspace:synthetic-${index}`,
    createdAt: 1,
    lastActiveAt: 1,
  },
}));
const reserved = new Error("Synthetic reservation measured before Git application");
const refreshRef = `refs/openclaw/workspace-base-refresh/${"a".repeat(64)}`;
async function refresh(owner: LocalWorkspaceOwner) {
  phase = "acquisition";
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    const operations = projectionOperations(
      owner,
      {
        ...store,
        update: async (...args) => {
          await store.update(...args);
          throw reserved;
        },
      },
      store.get(),
    );
    phase = "refresh";
    await assert.rejects(operations.applyBaseRefresh(refreshRef), (error) => error === reserved);
    const row = store.get()!;
    assert.equal(row.pending_ref, refreshRef);
    assert.equal(row.pending_target, "canonical");
    assert.equal(row.source_paths_json, sourcePaths);
    phase = "reset";
    await store.update(row, { pending_ref: null, pending_target: null });
  });
}
const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
try {
  const context = captureOpenClawStateWorkerContext({ env: process.env });
  for (const preparation of prepareLocalWorkspaceTreePacks(tree)) {
    await executeOpenClawStateWorker(context, {
      type: "localWorkspace.prepare",
      input: { preparation },
    });
  }
  for (const owner of owners) {
    await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, (store) =>
      store.create({
        worktree_id: owner.worktree.id,
        agent_id: owner.agentId,
        session_key: owner.sessionKey,
        session_id: owner.sessionId,
        lifecycle_revision: null,
        projection_path: localWorkspaceProjectionPath(owner),
        base_commit: baseCommit,
        source_paths_json: sourcePaths,
        source_paths_digest: null,
        baseline_ref: baselineRef,
        tree_root_digest: treeDigest,
        baseline_json: null,
        canonical_fingerprints: null,
        projection_fingerprints: null,
        checkpoint_json: null,
        pending_ref: null,
        pending_target: null,
        journal_json: null,
        journal_pack: null,
        paused_runtimes_json: null,
        created_at_ms: 1,
      }),
    );
  }
  phase = "idle";
  for (const owner of owners.slice(active)) {
    await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
      assert.equal(store.get()!.source_paths_json, sourcePaths);
    });
  }
  await refresh(owners[0]!);
  for (const bucket of ["acquisition", "refresh", "reset"] as const) {
    counts[bucket] = {};
  }
  globalThis.gc?.();
  const inspector = values.instrument === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const hostLoad = loadavg();
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await refresh(owners[index % active]!);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const profile = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  const sampledBytes = profile ? allocated(profile.profile.head) : null;
  const report = {
    revision: values.revision ?? "candidate",
    producerSha256: createHash("sha256").update(producerSource).digest("hex"),
    instrument: values.instrument,
    iterations,
    workspaces,
    active,
    admittedFilesPerWorkspace: paths,
    admittedPathsPerWorkspace: paths + 2,
    refreshesPerMinute,
    counts,
    idlePollsPerWorkspacePerSimulatedMinute: 1,
    idleRequestsPerSimulatedMinute: counts.idle,
    requestsPerSimulatedMinute: Object.fromEntries(
      (["acquisition", "refresh", "reset"] as const).map((bucket) => [
        bucket,
        Object.fromEntries(
          Object.entries(counts[bucket]).map(([command, count]) => [
            command,
            (count * refreshesPerMinute) / iterations,
          ]),
        ),
      ]),
    ),
    elapsedMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuUsPerRefresh: (cpu.user + cpu.system) / iterations,
    sampledBytesPerRefresh: sampledBytes === null ? null : sampledBytes / iterations,
    hostLoad,
    hostLoadAfter: loadavg(),
    memory: process.memoryUsage(),
    verified:
      "Every reservation committed with unchanged admission; every reset cleared its receipt",
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await state.closeOpenClawStateDatabaseAsync();
  await (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState();
}
