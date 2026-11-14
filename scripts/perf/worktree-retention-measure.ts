/**
 * Synthetic retired-checkout retention through ManagedWorktreeService.gc.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-retention-measure.ts <new-output>
 * Run two baseline A/A controls then five serial interleaved baseline/candidate pairs;
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse owner overlay. Setup/imports are untimed.
 * Acceptance: 20 empty retired roots finish, two non-empty roots retain their bytes/refs,
 * and the second pass/reopened service performs no repeated retention attempt or warning.
 * This fixture matches the observed empty directories, not the unrelated transcript DB
 * or scratch clone payloads. Report additional successful retirement work separately
 * from steady-state holds; logical counts, main CPU/allocation, and total process CPU
 * are measured. Native Git and state-broker child CPU are outside process CPU.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

assert(global.gc && process.argv[2], "--expose-gc and a new output directory are required");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Node 26+ is required");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output);
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
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
    file: path.join(output, "runtime.log"),
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config, config);
const { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } =
  await import("../../src/agents/worktrees/service.js");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const repo = path.join(output, "repo");
fs.mkdirSync(repo);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
git("init", "--quiet", "--template=", "-b", "main");
git("commit", "--quiet", "--allow-empty", "-m", "synthetic retirement");
const head = git("rev-parse", "HEAD");
let service = new ManagedWorktreeService({ env: process.env });
const repository = await service.resolveRepositoryIdentity(repo);
const records = Array.from({ length: 22 }, (_, index) => {
  const id = `retention-${index}`;
  return {
    id,
    name: id,
    path: path.join(output, "state/worktrees", repository.fingerprint, id),
    repoRoot: repo,
    repoFingerprint: repository.fingerprint,
    branch: `openclaw/${id}`,
    baseRef: "main",
    ownerKind: "manual" as const,
    createdAt: 1,
    lastActiveAt: 1,
    removedAt: Date.now() - SNAPSHOT_RETENTION_MS - 1,
    snapshotRef: `refs/openclaw/snapshots/${id}`,
  };
});
try {
  // Warm actual snapshot expiration, including its lazy imports, outside measurement.
  const warm = {
    ...records[0]!,
    id: "warm",
    name: "warm",
    branch: "openclaw/warm",
    path: path.join(output, "missing-warm"),
    snapshotRef: "refs/openclaw/snapshots/warm",
  };
  git("update-ref", `refs/heads/${warm.branch}`, head);
  git("update-ref", warm.snapshotRef, head);
  await insertRegistryWorktree(process.env, warm, { provisionedPaths: [] });
  assert.equal((await service.gc()).snapshotsPruned, 1);
  for (const [index, record] of records.entries()) {
    git("update-ref", `refs/heads/${record.branch}`, head);
    git("update-ref", record.snapshotRef, head);
    fs.mkdirSync(record.path, { recursive: true });
    if (index >= 20) {
      fs.writeFileSync(path.join(record.path, "keep.txt"), "unrecovered synthetic data");
    }
    await insertRegistryWorktree(process.env, record, { provisionedPaths: [] });
  }
  const measurements = [];
  for (let pass = 0; pass < 2; pass++) {
    global.gc();
    const allocation = getHeapStatistics().total_allocated_bytes;
    const cpu = process.cpuUsage();
    const mainCpu = process.threadCpuUsage();
    const load = os.loadavg();
    const started = performance.now();
    const result = await service.gc();
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const mainUsed = process.threadCpuUsage(mainCpu);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
    measurements.push({
      pass,
      wallMs,
      mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
      processCpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      load,
      result,
    });
    // A fresh service cannot use an in-memory hold to hide repeated work.
    service = new ManagedWorktreeService({ env: process.env });
  }
  for (const record of records.slice(20)) {
    assert.equal(
      fs.readFileSync(path.join(record.path, "keep.txt"), "utf8"),
      "unrecovered synthetic data",
    );
    assert.equal(git("rev-parse", record.snapshotRef), head);
    assert.equal(git("rev-parse", record.branch), head);
  }
  const report = {
    node: process.version,
    platform: process.platform,
    baseline: baseline ?? null,
    emptyRemaining: records.slice(0, 20).filter((r) => fs.existsSync(r.path)).length,
    retainedRecords: (await service.listRegistryRecords()).length,
    measurements,
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await drainGlobalSingletonLifecycleState();
}
