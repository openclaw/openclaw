/**
 * Synthetic archive maintenance through the real projection/store/filesystem owners.
 * Prepare once (outside measurement), then reuse serially from fresh processes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-archive-maintenance-measure.ts \
 *   --output <owned-directory> --prepare --worktrees 60 --files 10000
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/worktree-archive-maintenance-measure.ts \
 *   --output <owned-directory> --report <new-report.json> [--mode allocation] [--profile]
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse original-source overlay in every worker.
 * Run two identical-code controls, then at least five interleaved A/B pairs per mode.
 * Acceptance: identical archive decisions/roots, no host manifest parsing, lower main
 * CPU/allocation/blocking, and report any total CPU/wall regression over 20 percent.
 * All registered worktrees have real Git checkouts, separately prepared projections,
 * and 10k+ source files. Warmup, fixture creation, verification and forced GC are excluded.
 * The timed flow prepares each archive without deleting it, so exactly the same
 * files and owner state can be reused by both arms. Ordinary GC runs separately
 * with recent owners and must retain every checkout. This does not measure actual
 * checkout deletion, retention expiry, Docker, model turns, or whole-Gateway latency.
 * After the paired archive runs, --cleanup ages all 60 records through the registry
 * and runs real service.gc; --restore restores them through the service between
 * baseline and candidate cleanup proofs. Compare removed IDs and snapshot tree IDs,
 * not cleanup timings: the second cleanup follows a different restore lifecycle.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import { transformSync } from "esbuild";
import type { ManagedWorktreeRecord } from "../../src/agents/worktrees/types.js";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    prepare: { type: "boolean", default: false },
    worktrees: { type: "string", default: "60" },
    files: { type: "string", default: "10000" },
    "file-bytes": { type: "string", default: "1024" },
    report: { type: "string", default: "report.json" },
    mode: { type: "string", default: "timing" },
    profile: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
    restore: { type: "boolean", default: false },
  },
});
assert(values.output && global.gc, "--output and --expose-gc are required");
assert(["timing", "allocation"].includes(values.mode));
assert([values.prepare, values.cleanup, values.restore].filter(Boolean).length <= 1);
const output = path.resolve(values.output);
const fixturePath = path.join(output, "fixture.json");
const reportPath = path.resolve(output, values.report);
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceFingerprint = createHash("sha256");
for (const name of [
  "local-workspace-state.ts",
  "local-workspace-inventory.ts",
  "local-workspace-manifest-scan.ts",
  "local-workspace-store.types.ts",
  "workspace-manifest-computation.runtime.ts",
  "workspace-manifest.ts",
]) {
  const relative = `src/gateway/worker-environments/${name}`;
  const original = baseline && path.join(baseline, relative);
  sourceFingerprint
    .update(relative)
    .update(
      fs.readFileSync(
        original && fs.existsSync(original) ? original : path.join(sourceRoot, relative),
      ),
    );
}
const sourceDigest = sourceFingerprint.digest("hex");
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
let measured = false;
let mainManifestParses = 0;
Object.assign(globalThis, {
  __archiveManifestParse: () => {
    if (measured) {
      mainManifestParses++;
    }
  },
});
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("/workspace-manifest.ts")) {
      return nextLoad(url, context);
    }
    const code = fs.readFileSync(fileURLToPath(url), "utf8");
    const anchor = "): WorkerWorkspaceManifest {\n  if (Buffer.byteLength(raw)";
    assert(code.includes(anchor));
    return {
      format: "module",
      source: transformSync(
        code.replace(
          anchor,
          "): WorkerWorkspaceManifest {\n  globalThis.__archiveManifestParse();\n  if (Buffer.byteLength(raw)",
        ),
        { loader: "ts", format: "esm", target: "esnext" },
      ).code,
      shortCircuit: true,
    };
  },
});
if (values.prepare) {
  assert(!fs.existsSync(fixturePath), "Fixture already exists; reuse without --prepare");
  fs.mkdirSync(output, { recursive: true });
}
for (const directory of ["home", "tmp", "state"]) {
  fs.mkdirSync(path.join(output, directory), { recursive: true });
}
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
  },
});
const config = { worktreeMaxCount: 256 };
fs.writeFileSync(configPath, JSON.stringify(config));
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config);
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { insertRegistryWorktree, updateRegistryWorktree } =
  await import("../../src/agents/worktrees/registry.js");
const { withLocalWorkspaceProjection } =
  await import("../../src/gateway/worker-environments/local-workspace-projection.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
  await import("../../src/state/openclaw-state-db.js");
const { resolveOpenClawStateSqlitePath } =
  await import("../../src/state/openclaw-state-db.paths.js");
openOpenClawStateDatabase();
const service = new ManagedWorktreeService({ env: process.env, getConfig: () => config });
const repo = path.join(output, "repo");
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  }).trim();
type Fixture = {
  files: number;
  fileBytes: number;
  snapshot: string;
  records: ManagedWorktreeRecord[];
};
const ownerFor = (record: ManagedWorktreeRecord): LocalWorkspaceOwner => ({
  worktree: record,
  agentId: "main",
  sessionKey: record.ownerId!,
  sessionId: `synthetic-${record.id}`,
  lifecycleRevision: null,
  env: process.env,
  assertCurrent() {},
});
try {
  if (values.prepare) {
    const files = Number(values.files);
    const worktrees = Number(values.worktrees);
    const fileBytes = Number(values["file-bytes"]);
    assert(Number.isSafeInteger(files) && files >= 10000 && files <= 60000);
    assert(Number.isSafeInteger(worktrees) && worktrees >= 60);
    assert(Number.isSafeInteger(fileBytes) && fileBytes >= 128);
    fs.mkdirSync(repo);
    git(repo, ["init", "--quiet", "-b", "main"]);
    git(repo, ["config", "user.name", "Synthetic Benchmark"]);
    git(repo, ["config", "user.email", "synthetic@example.invalid"]);
    for (let index = 0; index < files; index++) {
      const filename = path.join(
        repo,
        "packages",
        `package-${String(Math.floor(index / 100)).padStart(3, "0")}`,
        "src",
        `module-${String(index).padStart(5, "0")}.ts`,
      );
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, `// synthetic module ${index}\n`.padEnd(fileBytes, "x"));
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "synthetic archive fixture"]);
    const snapshot = git(repo, ["rev-parse", "HEAD"]);
    const { fingerprint } = await service.resolveRepositoryIdentity(repo);
    const records: ManagedWorktreeRecord[] = [];
    for (let index = 0; index < worktrees; index++) {
      const id = `21612161-2161-4161-8161-${String(index).padStart(12, "0")}`;
      const checkout = path.join(output, "checkouts", id);
      const branch = `openclaw/synthetic-${index}`;
      git(repo, ["worktree", "add", "--quiet", "-b", branch, checkout, snapshot]);
      const record: ManagedWorktreeRecord = {
        id,
        name: `synthetic-${index}`,
        repoFingerprint: fingerprint,
        repoRoot: repo,
        path: checkout,
        branch,
        baseRef: "main",
        ownerKind: "session",
        ownerId: `agent:main:synthetic-${index}`,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      await insertRegistryWorktree(process.env, record, { provisionedPaths: [] });
      await withLocalWorkspaceProjection(ownerFor(record), (state) => state.prepare());
      records.push(record);
      console.error(JSON.stringify({ prepared: records.length, worktrees, files }));
    }
    fs.writeFileSync(fixturePath, JSON.stringify({ files, fileBytes, snapshot, records }));
    console.log(JSON.stringify({ prepared: true, fixturePath, files, worktrees }));
  } else if (values.restore) {
    const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    for (const record of fixture.records) {
      await service.restore({ id: record.id });
      assert(fs.existsSync(record.path));
      assert.equal(git(record.path, ["rev-parse", "HEAD"]), fixture.snapshot);
      console.error(JSON.stringify({ restored: record.id }));
    }
    console.log(JSON.stringify({ restored: fixture.records.length }));
  } else {
    assert(!fs.existsSync(reportPath), "Report must be a new file");
    const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const prepareArchive = (record: ManagedWorktreeRecord) =>
      withLocalWorkspaceProjection(ownerFor(record), async (state) => {
        await state.prepareArchive(fixture.snapshot);
        const current = state.current();
        assert.equal(current.pending_ref, null, "Tracked-only archive must need no overlay");
        return [record.id, current.baseline_ref, current.pending_ref];
      });
    await prepareArchive(fixture.records[0]!);
    const retained = await service.gc();
    assert.deepEqual(retained.removed, [], "Recent owners must retain every managed worktree");
    assert.equal(retained.eligibleCount, 0);
    if (values.cleanup) {
      for (const record of fixture.records) {
        await updateRegistryWorktree(process.env, record.id, { lastActiveAt: 0 });
      }
    }
    global.gc();
    const inspector = new Session();
    if (values.mode === "allocation") {
      await startCollectedHeapSampling(inspector, 32768);
    } else if (values.profile) {
      inspector.connect();
    }
    if (values.profile) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const gc = new GCProfiler();
    const initialMemory = process.memoryUsage();
    const initialCpu = process.cpuUsage();
    const initialThreadCpu = process.threadCpuUsage();
    const loadBefore = os.loadavg();
    const start = performance.now();
    const durations: number[] = [];
    const decisions: Array<Array<string | null>> = [];
    let cleanupResult: Awaited<ReturnType<typeof service.gc>> | undefined;
    measured = true;
    gc.start();
    if (values.cleanup) {
      cleanupResult = await service.gc();
    } else {
      for (const record of fixture.records) {
        const before = performance.now();
        decisions.push(await prepareArchive(record));
        durations.push(performance.now() - before);
      }
    }
    measured = false;
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(initialCpu);
    const mainCpu = process.threadCpuUsage(initialThreadCpu);
    const gcProfile = gc.stop();
    const finalMemory = process.memoryUsage();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
    loop.disable();
    const allocation =
      values.mode === "allocation"
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : null;
    if (values.profile) {
      fs.writeFileSync(
        `${reportPath}.cpuprofile`,
        JSON.stringify((await inspector.post("Profiler.stop")).profile),
      );
    }
    if (values.mode === "allocation" || values.profile) {
      inspector.disconnect();
    }
    if (cleanupResult) {
      assert.deepEqual(
        cleanupResult.removed.toSorted(),
        fixture.records.map(({ id }) => id).toSorted(),
      );
      const archived = new Map(
        (await service.listRegistryRecords()).map((record) => [record.id, record]),
      );
      for (const record of fixture.records) {
        const current = archived.get(record.id);
        assert(current?.removedAt !== undefined && current.snapshotRef);
        assert(!fs.existsSync(record.path), "Cleanup must remove each checkout");
        decisions.push([
          record.id,
          git(repo, ["rev-parse", `${current.snapshotRef}^{tree}`]),
          null,
        ]);
      }
    }
    const stats = gcProfile?.statistics ?? [];
    const cpuMs = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;
    const result = {
      mode: values.mode,
      operation: values.cleanup ? "cleanup" : "archive",
      baseline: baseline ?? null,
      sourceDigest,
      node: process.version,
      platform: process.platform,
      filesPerWorktree: fixture.files,
      fileBytes: fixture.fileBytes,
      worktrees: fixture.records.length,
      databaseBytes: fs.statSync(resolveOpenClawStateSqlitePath()).size,
      wallMs,
      totalProcessCpuMs: cpuMs(cpu),
      mainThreadCpuMs: cpuMs(mainCpu),
      mainManifestParses,
      allocationBytes: allocation,
      gc: {
        count: stats.length,
        totalMs: stats.reduce((sum, entry) => sum + entry.cost / 1000, 0),
        maxMs: Math.max(0, ...stats.map((entry) => entry.cost / 1000)),
      },
      eventLoop: {
        maxMs: loop.max / 1e6,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
      },
      durationsMs: durations,
      decisionDigest: createHash("sha256").update(JSON.stringify(decisions)).digest("hex"),
      decisions,
      gcRetained: { removed: retained.removed, eligibleCount: retained.eligibleCount },
      cleanupResult,
      initialMemory,
      finalMemory,
      loadBefore,
      loadAfter: os.loadavg(),
    };
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, decisions: undefined, durationsMs: undefined }));
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
