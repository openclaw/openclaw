/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-removal-snapshot-measure.ts \
 *   --output <new-owned-directory> --files 62000 --file-bytes 18432 --tracked 2388
 * Run two identical-code controls, then five serial interleaved baseline/candidate pairs.
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse pinned source overlay in every worker.
 * Each process creates a fresh native Git repository and shared-state database, provisions
 * the dependency tree through service.create, then times the real service.remove boundary.
 * Setup, verification and worker drainage are outside the timed window. No remote/model,
 * session transport, competing writer or unrelated agent database is simulated.
 * Acceptance at the default size: snapshot <10s and >90% faster, zero dependency
 * chunk writes and one .env chunk; preserve tracked edits/nonignored user files,
 * improve CPU/allocation without a >20% removal regression. Filesystem caches are
 * warm after creation; every run has fresh process/database state, with workers
 * warmed by creation. This does not claim a cold-storage latency bound.
 * Each Git subprocess and registry mutation gets an inclusive host-boundary timing; these
 * include IPC/admission and are not native SQL-only times. Main allocation is exact V8;
 * process CPU includes workers but excludes Git children. Use --cpu-prof for CPU profiles.
 * --profile is a separate diagnostic pass: real worker CPU/allocation sampling, SQL
 * statement counts/native duration, and writer-hold intervals; exclude its timings.
 * All files are synthetic. The output retains the fixture, report and operation timings.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "18432" },
    tracked: { type: "string", default: "2388" },
    profile: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new task-owned directory");
const output = path.resolve(values.output);
const files = Number(values.files);
const fileBytes = Number(values["file-bytes"]);
const tracked = Number(values.tracked);
assert([files, fileBytes, tracked].every((value) => Number.isSafeInteger(value) && value > 0));
assert(tracked >= 3);
fs.mkdirSync(output);
for (const directory of ["home", "tmp", "state", "repo"]) {
  fs.mkdirSync(path.join(output, directory));
}
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
const profileEnv: Record<string, string> = values.profile
  ? {
      OPENCLAW_BENCH_RETAINED_WORKER_DIR: path.join(output, "profiles"),
      OPENCLAW_BENCH_COUNT_SQL: "1",
      OPENCLAW_BENCH_SAMPLE_CPU: "1",
      OPENCLAW_BENCH_SAMPLE_ALLOCATION: "1",
    }
  : {};
Object.assign(process.env, profileEnv);
if (baseline || values.profile) {
  await import("./worker-retained-heap-preload.js");
}
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const fingerprint = createHash("sha256");
for (const relative of [
  "src/agents/worktrees/removal.ts",
  "src/agents/worktrees/snapshot-host.ts",
  "src/agents/worktrees/snapshot-inventory.ts",
  "src/agents/worktrees/provisioned-snapshot.ts",
]) {
  const original = baseline && path.join(baseline, relative);
  fingerprint
    .update(relative)
    .update(
      fs.readFileSync(
        original && fs.existsSync(original) ? original : path.join(sourceRoot, relative),
      ),
    );
}
const sourceDigest = fingerprint.digest("hex");
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    ...(baseline ? { OPENCLAW_BENCH_BASELINE_DIR: baseline } : {}),
    ...profileEnv,
  },
});
const config = {
  worktreeAcceleration: false,
  logging: {
    level: "info" as const,
    consoleLevel: "silent" as const,
    file: path.join(output, "runtime.log"),
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
type Timing = {
  kind: string;
  operation: string;
  elapsedMs: number;
  bytes?: number;
  mainThreadCpuMs?: number;
  processCpuMs?: number;
  mainThreadAllocatedBytes?: number;
};
const timings: Timing[] = [];
let measuring = false;
const key = Symbol.for("openclaw.perf.worktree-removal-snapshot");
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: (kind: string, args: unknown[]) => {
    const started = performance.now();
    const snapshotCpu = kind === "snapshot" ? process.cpuUsage() : undefined;
    const snapshotMainCpu = kind === "snapshot" ? process.threadCpuUsage() : undefined;
    const snapshotAllocation =
      kind === "snapshot" ? getHeapStatistics().total_allocated_bytes : undefined;
    let operation = kind;
    let bytes: number | undefined;
    if (kind === "git") {
      const argv = args[1] as string[];
      let index = 0;
      while (argv[index]?.startsWith("-")) {
        index += argv[index] === "-c" || argv[index] === "--git-dir" ? 2 : 1;
      }
      operation =
        argv[index] === "worktree" ? `worktree.${argv[index + 1]}` : (argv[index] ?? "unknown");
    } else if (kind === "registry") {
      const command = args[1] as {
        type: string;
        input: { value?: { kind?: string; data?: Uint8Array } };
      };
      operation = command.type + (command.input.value?.kind ? `.${command.input.value.kind}` : "");
      bytes = command.input.value?.data?.byteLength;
    }
    return () => {
      if (measuring) {
        const cpu = snapshotCpu && process.cpuUsage(snapshotCpu);
        const mainCpu = snapshotMainCpu && process.threadCpuUsage(snapshotMainCpu);
        timings.push({
          kind,
          operation,
          elapsedMs: performance.now() - started,
          ...(bytes === undefined ? {} : { bytes }),
          ...(cpu && mainCpu && snapshotAllocation !== undefined
            ? {
                processCpuMs: (cpu.user + cpu.system) / 1000,
                mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1000,
                mainThreadAllocatedBytes:
                  getHeapStatistics().total_allocated_bytes - snapshotAllocation,
              }
            : {}),
        });
      }
    };
  },
});
const hooks = registerHooks({
  load(url, context, next) {
    const names = url.endsWith("/src/infra/git-exec.ts")
      ? ["executeGitCommand", "executeGitCommandBytes", "executeGitCommandBuffered"]
      : url.endsWith("/src/agents/worktrees/registry-run-end.ts")
        ? ["runWorktreeRunEndCommand"]
        : url.endsWith("/src/agents/worktrees/snapshot-host.ts")
          ? ["captureManagedWorktreeSnapshot"]
          : [];
    if (!names.length) {
      return next(url, context);
    }
    let source = fs.readFileSync(new URL(url), "utf8");
    for (const name of names) {
      const pattern = new RegExp(`export (async )?function ${name}\\(`);
      assert(pattern.test(source), `Missing instrumentation boundary: ${name}`);
      source = source.replace(pattern, `$1function ${name}Measured(`);
      const kind = name.startsWith("executeGit")
        ? "git"
        : name.startsWith("runWorktree")
          ? "registry"
          : "snapshot";
      source += `\nexport async function ${name}(...args: Parameters<typeof ${name}Measured>) {
        const finish = globalThis[Symbol.for("openclaw.perf.worktree-removal-snapshot")](${JSON.stringify(kind)}, args);
        try { return await ${name}Measured(...args); } finally { finish(); }
      }\n`;
    }
    return { format: "module-typescript", shortCircuit: true, source };
  },
});
const repo = path.join(output, "repo");
const git = (args: string[], cwd = repo) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
git(["init", "-b", "main", "--template="]);
git(["config", "user.name", "Synthetic Benchmark"]);
git(["config", "user.email", "benchmark@example.invalid"]);
git(["config", "maintenance.auto", "false"]);
fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.env.local\n");
fs.writeFileSync(path.join(repo, ".worktreeinclude"), "node_modules/\n.env.local\n");
fs.mkdirSync(path.join(repo, "src"));
for (let index = 0; index < tracked - 2; index++) {
  fs.writeFileSync(
    path.join(repo, "src", `${index}.ts`),
    `export const value${index} = ${index};\n`,
  );
}
git(["add", "."]);
git(["commit", "-m", "synthetic source"]);
const dependency = Buffer.alloc(fileBytes, 97);
const dependencyDirectory = (index: number) => {
  const name = `package-${Math.floor(index / 100)}`;
  return path.join("node_modules", ".pnpm", `${name}@1.0.0`, "node_modules", name, "lib");
};
for (let index = 0; index < files; index++) {
  const directory = path.join(repo, dependencyDirectory(index));
  if (index % 100 === 0) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(directory, `${index}.js`), dependency);
}
fs.writeFileSync(path.join(repo, ".env.local"), "SYNTHETIC_SETTING=initial\n");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(config, config);
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { getRegistryWorktreeProvisionedState } =
  await import("../../src/agents/worktrees/registry.js");
const { getRegistryWorktreeProvisionedChunk } =
  await import("../../src/agents/worktrees/registry-read.js");
const service = new ManagedWorktreeService({ env: process.env, getConfig: () => config });
const profiledWorkers: string[] = [];
async function profileWorkers(operation: "start" | "stop") {
  if (!values.profile) {
    return;
  }
  const directory = path.join(output, "profiles");
  if (operation === "start") {
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".ready.json"))) {
      const ready = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as {
        script: string;
      };
      if (
        /^(git-operation|sqlite-store)\.worker\./u.test(ready.script) ||
        ready.script.startsWith("storage-worker.")
      ) {
        profiledWorkers.push(path.join(directory, name.slice(0, -".ready.json".length)));
      }
    }
    assert(profiledWorkers.length > 0, "No real Git/SQLite workers available for profiling");
  }
  for (const prefix of profiledWorkers) {
    const command = `${prefix}.command.json`;
    const id = `removal-${operation}`;
    fs.writeFileSync(`${command}.tmp`, JSON.stringify({ id, operation }));
    fs.renameSync(`${command}.tmp`, command);
    const reply = `${prefix}.${id}.json`;
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(reply)) {
      assert(Date.now() < deadline, `Timed out profiling ${path.basename(prefix)}`);
      await delay(25);
    }
    assert.equal(JSON.parse(fs.readFileSync(reply, "utf8")).ok, true);
  }
}
try {
  const created = await service.create({
    repoRoot: repo,
    name: "synthetic-removal",
    baseRef: "HEAD",
    runSetupScript: false,
  });
  assert.equal(
    fs.statSync(path.join(created.path, dependencyDirectory(files - 1), `${files - 1}.js`)).size,
    fileBytes,
  );
  fs.writeFileSync(path.join(created.path, "src/0.ts"), "export const userEdit = true;\n");
  fs.writeFileSync(path.join(created.path, "user-notes.txt"), "synthetic unsaved user work\n");
  fs.writeFileSync(path.join(created.path, ".env.local"), "SYNTHETIC_SETTING=edited\n");
  if (values.profile) {
    const { runGitWorkerOperation } = await import("../../src/infra/git-worker.js");
    // Creation and maintenance have separate workers; admit the measured owner first.
    await runGitWorkerOperation({
      type: "worktree.cleanup-inspection",
      input: { kind: "provisioned", checkoutPath: created.path, provisionedPaths: [] },
    });
  }
  await profileWorkers("start");
  const loadBefore = os.loadavg();
  const memoryBefore = process.memoryUsage();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const gc = new GCProfiler();
  loop.enable();
  gc.start();
  const allocation = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocation), "Use a runtime exposing exact V8 allocation counters");
  const mainCpu = process.threadCpuUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  measuring = true;
  const removed = await service.remove({ id: created.id, reason: "synthetic performance fixture" });
  measuring = false;
  const elapsedMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  const usedMainCpu = process.threadCpuUsage(mainCpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
  const gcStats = gc.stop()?.statistics ?? [];
  loop.disable();
  await profileWorkers("stop");
  assert(removed.removed && removed.snapshotRef);
  assert.equal(git(["show", `${removed.snapshotRef}:src/0.ts`]), "export const userEdit = true;");
  assert.equal(
    git(["show", `${removed.snapshotRef}:user-notes.txt`]),
    "synthetic unsaved user work",
  );
  const states = await getRegistryWorktreeProvisionedState(process.env, created.id);
  assert(states?.some((state) => state.path === ".env.local" && state.chunks === 1));
  assert.equal(
    Buffer.from(
      (await getRegistryWorktreeProvisionedChunk(process.env, {
        worktreeId: created.id,
        path: ".env.local",
        chunkIndex: 0,
      }))!,
    ).toString(),
    "SYNTHETIC_SETTING=edited\n",
  );
  const summary: Record<
    string,
    { count: number; elapsedMs: number; maxMs: number; bytes: number }
  > = {};
  for (const timing of timings) {
    const row = (summary[timing.operation] ??= { count: 0, elapsedMs: 0, maxMs: 0, bytes: 0 });
    row.count++;
    row.elapsedMs += timing.elapsedMs;
    row.maxMs = Math.max(row.maxMs, timing.elapsedMs);
    row.bytes += timing.bytes ?? 0;
  }
  const result = {
    sourceDigest,
    baseline: baseline ?? null,
    diagnosticProfile: values.profile,
    node: process.version,
    platform: process.platform,
    tracked,
    files,
    fileBytes,
    provisionedBytes: files * fileBytes,
    elapsedMs,
    snapshotMs: summary.snapshot?.elapsedMs,
    snapshot: timings.find((timing) => timing.kind === "snapshot"),
    totalProcessCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    mainThreadCpuMs: (usedMainCpu.user + usedMainCpu.system) / 1000,
    mainThreadAllocatedBytes: allocatedBytes,
    gc: {
      count: gcStats.length,
      totalMs: gcStats.reduce((sum, entry) => sum + entry.cost / 1000, 0),
      maxMs: Math.max(0, ...gcStats.map((entry) => entry.cost / 1000)),
    },
    eventLoopMaxMs: loop.max / 1e6,
    persistedProvisionedFiles: states?.length,
    snapshotTree: git(["rev-parse", `${removed.snapshotRef}^{tree}`]),
    persistedDependencyFiles: states?.filter((state) => state.path.startsWith("node_modules/"))
      .length,
    summary,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    loadBefore,
    loadAfter: os.loadavg(),
  };
  fs.writeFileSync(
    path.join(output, "operations.jsonl"),
    timings.map((timing) => JSON.stringify(timing)).join("\n") + "\n",
  );
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.persistedDependencyFiles, baseline ? files : 0);
  assert.equal(result.persistedProvisionedFiles, baseline ? files + 1 : 1);
  assert.equal(
    summary["worktrees.writeProvisionedSnapshot.chunk"]?.count,
    baseline ? files + 1 : 1,
  );
  assert.equal(
    summary["worktrees.writeProvisionedSnapshot.chunk"]?.bytes,
    (baseline ? files * fileBytes : 0) + Buffer.byteLength("SYNTHETIC_SETTING=edited\n"),
  );
  if (!baseline && !values.profile) {
    assert(
      result.snapshotMs !== undefined && result.snapshotMs < 10_000,
      "Candidate snapshot exceeded the 10s acceptance bound",
    );
  }
} finally {
  measuring = false;
  await drainGlobalSingletonLifecycleState();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
}
