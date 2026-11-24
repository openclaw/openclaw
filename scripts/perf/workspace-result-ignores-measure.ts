/**
 * Synthetic local workspace checkpoint through the real projection/store/staging owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-result-ignores-measure.ts <scratch> <label> <accepted|rejected> [timing|allocation|cpu]
 * OPENCLAW_BENCH_BASELINE_DIR may select an immutable sparse source overlay using
 * worker-retained-heap-preload. Freeze changed owners for both arms before running.
 * Run fresh processes serially: two baseline A/A pairs, then five interleaved A/B
 * pairs. Default fixture: 22k tracked files +40k ignored files, 1.144 GB logical.
 * WORKSPACE_BENCH_TRACKED/IGNORED override counts for smoke checks only.
 * WORKSPACE_BENCH_OUTPUT=tool-cache writes unignored npm cache entries instead,
 * including one 64 MiB + 1 byte object. The 62k-file fixture is 1.21 GB logical;
 * baseline must reject that object, candidate must publish only the source edit.
 * Acceptance: preserve one tracked edit and exclude every ignored output; rejected
 * changed bytes become 12 accepted bytes. Compare median/p95 wall, CPU and sampled
 * allocation against identical-code controls; timing and profiling are separate.
 * This measures warm-owner checkpointing on the host filesystem, not btrfs,
 * container preparation, a model turn, or an agent-database workload.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const [scratchArg, label, expected, instrument = "timing"] = process.argv.slice(2);
assert(scratchArg && label && /^[a-zA-Z0-9_-]+$/u.test(label));
assert(expected === "accepted" || expected === "rejected");
assert(["timing", "allocation", "cpu"].includes(instrument));
assert(global.gc, "--expose-gc is required");
const scratch = path.resolve(scratchArg);
const run = path.join(scratch, label);
const files = path.join(run, "fixture");
await fs.mkdir(run, { recursive: true });
await fs.mkdir(files);
const profileRoot = path.join(run, "workers");
process.env.OPENCLAW_STATE_DIR = path.join(files, "state");
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_SYSTEM = os.devNull;
process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR = profileRoot;
process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = instrument === "allocation" ? "1" : "0";
process.env.OPENCLAW_BENCH_SAMPLE_CPU = instrument === "cpu" ? "1" : "0";
await import("./worker-retained-heap-preload.ts");
const { withLocalWorkspaceProjection } =
  await import("../../src/gateway/worker-environments/local-workspace-projection.js");
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
  await import("../../src/state/openclaw-state-db.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { parseWorkerWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest.js");
const { parseChangedWorkspaceResult } =
  await import("../../src/gateway/worker-environments/workspace-manifest-comparison.js");
const tracked = Number(process.env.WORKSPACE_BENCH_TRACKED ?? 22_000);
const ignored = Number(process.env.WORKSPACE_BENCH_IGNORED ?? 40_000);
const toolCache = process.env.WORKSPACE_BENCH_OUTPUT === "tool-cache";
const oversizedCacheBytes = 64 * 1024 * 1024 + 1;
const cacheObject = ".npm/_cacache/0000/0.txt";
assert(
  Number.isSafeInteger(tracked) && tracked > 0 && Number.isSafeInteger(ignored) && ignored > 0,
);
const repo = path.join(files, "source");
const canonical = path.join(files, "canonical");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
await fs.mkdir(repo);
git(repo, "init", "--quiet", "-b", "main");
git(repo, "config", "user.name", "Synthetic");
git(repo, "config", "user.email", "synthetic@example.invalid");
const trackedBytes = 12_000;
const ignoredBytes = 22_000;
async function writeGroup(root: string, count: number, bytes: number, prefix: string) {
  const content = Buffer.alloc(bytes, 65);
  for (let start = 0; start < count; start += 100) {
    const directory = path.join(root, prefix, String(Math.floor(start / 100)).padStart(4, "0"));
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(100, count - start) }, (_, offset) =>
        fs.writeFile(path.join(directory, `${start + offset}.txt`), content),
      ),
    );
  }
}
await writeGroup(repo, tracked, trackedBytes, "source");
await fs.writeFile(path.join(repo, ".gitignore"), "dist/\n.cache/\n");
git(repo, "add", "-A");
git(repo, "commit", "--quiet", "-m", "synthetic base");
git(repo, "worktree", "add", "--quiet", "-b", "openclaw/synthetic", canonical);
const sessionKey = `agent:main:dashboard:synthetic-${randomUUID()}`;
const owner = {
  agentId: "main",
  sessionKey,
  sessionId: randomUUID(),
  lifecycleRevision: null,
  assertCurrent() {},
  worktree: {
    id: randomUUID(),
    name: "synthetic",
    repoFingerprint: "synthetic",
    repoRoot: repo,
    path: canonical,
    branch: "openclaw/synthetic",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: sessionKey,
    createdAt: 0,
    lastActiveAt: 0,
  },
};
setRuntimeConfigSnapshot({});
openOpenClawStateDatabase();
try {
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const base = await withLocalWorkspaceProjection(owner, (state) => state.baselineDocument());
  if (toolCache) {
    await writeGroup(projection, ignored, ignoredBytes, ".npm/_cacache");
    await fs.truncate(path.join(projection, cacheObject), oversizedCacheBytes);
  } else {
    const half = Math.floor(ignored / 2);
    await writeGroup(projection, half, ignoredBytes, "dist");
    await writeGroup(projection, ignored - half, ignoredBytes, ".cache/openclaw-bun");
  }
  const editedPath = "source/0000/0.txt";
  const edit = "source edit\n";
  await fs.writeFile(path.join(projection, editedPath), edit);
  async function retainedWorkers() {
    const names: string[] = [];
    for (const name of await fs.readdir(profileRoot)) {
      if (!name.endsWith(".ready.json")) {
        continue;
      }
      const identity = JSON.parse(await fs.readFile(path.join(profileRoot, name), "utf8"));
      // A custody heartbeat retires between operations; its ready file is historical.
      if (identity.script !== "gateway-state-owner-heartbeat.worker.ts") {
        names.push(name);
      }
    }
    return names;
  }
  const ready = await retainedWorkers();
  async function workerCommand(operation: "start" | "stop") {
    return await Promise.all(
      ready.map(async (name) => {
        const prefix = path.join(profileRoot, name.slice(0, -".ready.json".length));
        const id = `measure-${operation}`;
        const temporary = `${prefix}.command.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ id, operation }));
        await fs.rename(temporary, `${prefix}.command.json`);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            const reply = JSON.parse(await fs.readFile(`${prefix}.${id}.json`, "utf8"));
            assert(reply.ok, JSON.stringify(reply));
            return reply;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
              throw error;
            }
          }
          await delay(10);
        }
        throw new Error(`Missing worker ${operation} reply: ${name}`);
      }),
    );
  }
  const inspector = new Session();
  if (instrument === "allocation") {
    await startCollectedHeapSampling(inspector, 32768);
  } else if (instrument === "cpu") {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  if (instrument !== "timing") {
    await workerCommand("start");
  }
  global.gc();
  const load = os.loadavg();
  const cpu = process.cpuUsage();
  const mainCpu = process.threadCpuUsage();
  const started = performance.now();
  let errorMessage: string | undefined;
  try {
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  const elapsedMs = performance.now() - started;
  const processCpu = process.cpuUsage(cpu);
  const threadCpu = process.threadCpuUsage(mainCpu);
  const workerProfiles = instrument === "timing" ? [] : await workerCommand("stop");
  let mainAllocationBytes: number | undefined;
  if (instrument === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    mainAllocationBytes = sumSampledHeapBytes(profile.head);
    await fs.writeFile(path.join(run, "main.heapprofile"), JSON.stringify(profile));
  } else if (instrument === "cpu") {
    const { profile } = await inspector.post("Profiler.stop");
    await fs.writeFile(path.join(run, "main.cpuprofile"), JSON.stringify(profile));
  }
  if (instrument !== "timing") {
    inspector.disconnect();
  }
  let changedFiles: number;
  let changedBytes: number;
  if (expected === "rejected") {
    assert(errorMessage, "Expected staged-result byte cap rejection");
    if (toolCache) {
      assert(
        errorMessage.includes(`Cloud workspace result is too large: ${cacheObject}`),
        errorMessage,
      );
      // Fixture changed bytes are rejected before publication, including the source edit.
      changedBytes =
        ignored * ignoredBytes - ignoredBytes + oversizedCacheBytes + Buffer.byteLength(edit);
      changedFiles = ignored + 1;
    } else {
      assert(
        errorMessage.includes("Cloud workspace staged result exceeds its byte limit"),
        errorMessage,
      );
      const match = /: (\d+) bytes across (\d+) changed files\/symlinks/u.exec(errorMessage);
      assert(match, errorMessage);
      changedBytes = Number(match[1]);
      changedFiles = Number(match[2]);
      assert.equal(changedBytes, ignored * ignoredBytes + Buffer.byteLength(edit));
      assert.equal(changedFiles, ignored + 1);
    }
    assert.equal((await fs.stat(path.join(canonical, editedPath))).size, trackedBytes);
  } else {
    assert.equal(errorMessage, undefined);
    const accepted = await withLocalWorkspaceProjection(owner, (state) => state.baselineDocument());
    const baseManifest = parseWorkerWorkspaceManifest(base.rawManifest, base.manifestRef);
    const acceptedManifest = parseWorkerWorkspaceManifest(
      accepted.rawManifest,
      accepted.manifestRef,
    );
    assert.deepEqual(
      acceptedManifest.entries.map((entry) => entry.path),
      baseManifest.entries.map((entry) => entry.path),
    );
    const result = parseChangedWorkspaceResult(baseManifest, acceptedManifest);
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      [editedPath],
    );
    changedFiles = result.entries.length;
    changedBytes = Buffer.byteLength(edit);
    assert.equal(await fs.readFile(path.join(canonical, editedPath), "utf8"), edit);
    assert.equal(
      await fs.stat(path.join(canonical, toolCache ? ".npm" : "dist")).catch(() => undefined),
      undefined,
    );
  }
  const finalReady = await retainedWorkers();
  const report = {
    label,
    expected,
    instrument,
    node: process.version,
    platform: process.platform,
    load,
    trackedFiles: tracked + 1,
    ignoredFiles: ignored,
    outputKind: toolCache ? "tool-cache" : "ignored-build-output",
    logicalBytes:
      tracked * trackedBytes +
      ignored * ignoredBytes +
      14 +
      (toolCache ? oversizedCacheBytes - ignoredBytes : 0),
    changedFiles,
    changedBytes,
    elapsedMs,
    processCpu,
    mainCpu: threadCpu,
    mainAllocationBytes,
    workerProfiles,
    unprofiledNewWorkers: finalReady.filter((name) => !ready.includes(name)),
    sourceOverlay: process.env.OPENCLAW_BENCH_BASELINE_DIR ?? null,
    error: errorMessage,
  };
  await fs.writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearRuntimeConfigSnapshot();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  await fs.rm(files, { recursive: true, force: true });
}
