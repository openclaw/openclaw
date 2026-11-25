/**
 * Synthetic run-boundary activity proof. First seed the existing agent fixture:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-startup-inspection.ts \
 *   seed --state-dir <new-root>/state --gib 35
 * Then run this script with --prepare <root> [--files 62000], followed by <root> <new-result.json>.
 * OPENCLAW_BENCH_BASELINE_DIR selects frozen registry, run-lease and workspace-sandbox owners.
 * Run two baseline A/A controls then five serial alternating baseline/candidate pairs.
 * Acceptance: admission records recent activity, repeated short runs do not write again;
 * report the cost of the first durable write separately from coalesced boundaries.
 * CPU covers this process (including threads), allocation only the main isolate; Git and
 * the state broker are child processes and excluded. Filesystem caches are warm. A large
 * agent DB is present, but run leases only use the state registry; workspace preparation
 * also reads its exact session. Report the actual filesystem, never infer btrfs.
 * --restore measures explicit restoration after real snapshot removal,
 * then 20 warm preparations. Before the timed window, wait for paced deletion to
 * finish. Both baseline and candidate must restore the exact saved files.
 * Run A/A and five serial A/B pairs on the same owned fixture, using unique report paths.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prepare: { type: "string" },
    files: { type: "string", default: "62000" },
    restore: { type: "boolean", default: false },
  },
});
const root = path.resolve(values.prepare ?? positionals[0]!);
const stateDir = path.join(root, "state");
const seed = JSON.parse(
  fs.readFileSync(path.join(stateDir, ".agent-startup-inspection.json"), "utf8"),
);
assert.equal(seed.marker, "openclaw-agent-startup-inspection-v1");
assert(!seed.seedIncomplete, "Complete the synthetic agent DB seed first");
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
const configPath = path.join(root, "activity-config.json");
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: stateDir,
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: "Synthetic Benchmark",
    GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Benchmark",
    GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
  },
});
const config = {
  logging: {
    level: "warn" as const,
    consoleLevel: "silent" as const,
    file: path.join(root, "runtime.log"),
  },
};
if (values.prepare) {
  fs.writeFileSync(configPath, JSON.stringify(config), { flag: "wx" });
}
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config, config);
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { updateRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { acquireWorktreeRunLease } = await import("../../src/agents/worktrees/run-lease.js");
const { resolveAttemptWorkspaceSandbox } = await import("../../src/agents/workspace-sandbox.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const service = new ManagedWorktreeService({ env: process.env });
const sessionKey = "agent:main:activity-benchmark";
const markerPath = path.join(root, "activity-fixture.json");
try {
  if (values.prepare) {
    const files = Number(values.files);
    assert(Number.isSafeInteger(files) && files > 0);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const payload = Buffer.alloc(18_432, 0x78);
    for (let index = 0; index < files; index++) {
      const directory = path.join(repo, `d${Math.floor(index / 100)}`);
      if (index % 100 === 0) {
        fs.mkdirSync(directory);
      }
      payload.writeUInt32LE(index);
      fs.writeFileSync(path.join(directory, `f${index}.txt`), payload);
    }
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { env: process.env, stdio: "pipe" });
    git("init", "--quiet", "--template=", "-b", "main");
    git("add", ".");
    git("commit", "--quiet", "-m", "synthetic activity");
    const created = await service.create({
      repoRoot: repo,
      name: "activity",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "activity-benchmark",
        updatedAt: 1,
        worktree: { id: created.id, branch: created.branch, repoRoot: repo },
      },
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ created, files, checkoutBytes: files * payload.length }),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({ fixture: markerPath, files, checkoutBytes: files * payload.length }),
    );
  } else {
    assert(global.gc && positionals[1], "--expose-gc and a new result path are required");
    assert(
      Number.isFinite(getHeapStatistics().total_allocated_bytes),
      "Node 26+ allocation counters required",
    );
    const fixture = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const { id, path: workspaceDir } = fixture.created;
    const lease = async () => {
      const held = await acquireWorktreeRunLease(id, { env: process.env });
      await held.release();
    };
    const workspace = async () => {
      using prepared = await resolveAttemptWorkspaceSandbox({
        workspaceDir,
        sessionId: "activity-benchmark",
        sessionKey,
        agentId: "main",
        config,
      });
      assert.equal(prepared.effectiveCwd, workspaceDir);
    };
    const measurements = [];
    if (values.restore) {
      await workspace();
      const saved = path.join(workspaceDir, "saved-task.txt");
      fs.writeFileSync(saved, "synthetic saved work\n");
      assert((await service.remove({ id, reason: "synthetic-explicit-restore" })).removed);
      const parent = path.dirname(workspaceDir);
      const deletionDeadline = Date.now() + 120_000;
      while (fs.readdirSync(parent).some((name) => name.startsWith(".openclaw-removing-"))) {
        assert(Date.now() < deletionDeadline, "Synthetic retired checkout cleanup did not settle");
        await delay(100);
      }
      for (const [phase, iterations] of [
        ["restore", 1],
        ["warm", 20],
      ] as const) {
        global.gc();
        const load = os.loadavg();
        const allocation = getHeapStatistics().total_allocated_bytes;
        const cpu = process.cpuUsage();
        const mainCpu = process.threadCpuUsage();
        const start = performance.now();
        let failure: unknown;
        try {
          for (let index = 0; index < iterations; index++) {
            if (phase === "restore") {
              await service.restore({ id });
            } else {
              await workspace();
            }
          }
        } catch (error) {
          failure = error;
        }
        const wallMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        const mainUsed = process.threadCpuUsage(mainCpu);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
        measurements.push({
          owner: phase === "restore" ? "worktrees.restore" : "workspace",
          phase,
          iterations,
          wallMs,
          processCpuMs: (used.user + used.system) / 1000,
          mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
          allocatedBytes,
          outcome: failure ? "refused" : "ready",
          load,
        });
        assert.equal(failure, undefined);
        assert.equal(fs.readFileSync(saved, "utf8"), "synthetic saved work\n");
        assert.equal(fs.statSync(path.join(workspaceDir, "d0/f0.txt")).size, 18_432);
      }
    }
    for (const [owner, run] of values.restore
      ? []
      : ([
          ["lease", lease],
          ["workspace", workspace],
        ] as const)) {
      await run();
      await updateRegistryWorktree(process.env, id, { lastActiveAt: 1 });
      let observedActivity = 1;
      for (const [phase, iterations] of [
        ["first-write", 1],
        ["coalesced", 20],
      ] as const) {
        global.gc();
        const startedAt = Date.now();
        const allocation = getHeapStatistics().total_allocated_bytes;
        const cpu = process.cpuUsage();
        const mainCpu = process.threadCpuUsage();
        const start = performance.now();
        for (let index = 0; index < iterations; index++) {
          await run();
        }
        const wallMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        const mainUsed = process.threadCpuUsage(mainCpu);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
        const record = (await service.listRegistryRecords()).find((row) => row.id === id);
        assert(record);
        if (!baseline && phase === "first-write") {
          assert(record.lastActiveAt >= startedAt, `${owner} must record actual use`);
        } else {
          assert.equal(record.lastActiveAt, observedActivity);
        }
        observedActivity = record.lastActiveAt;
        measurements.push({
          owner,
          phase,
          iterations,
          wallMs,
          processCpuMs: (used.user + used.system) / 1000,
          mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
          allocatedBytes,
          lastActiveAt: record.lastActiveAt,
        });
      }
    }
    const result = {
      node: process.version,
      platform: process.platform,
      baseline: baseline ?? null,
      load: os.loadavg(),
      files: fixture.files,
      checkoutBytes: fixture.checkoutBytes,
      agentDatabaseBytes: fs.statSync(seed.databasePath).size,
      measurements,
    };
    fs.writeFileSync(path.resolve(positionals[1]), JSON.stringify(result, null, 2), { flag: "wx" });
    console.log(JSON.stringify(result));
  }
} finally {
  await drainGlobalSingletonLifecycleState();
}
