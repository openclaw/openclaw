/**
 * Canonical checkpoint contention through the real projection/store owner.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-checkpoint-measure.ts
 *   --output .local/checkpoint-candidate --mode owner --requests 2048 --burst 64
 * Add --revision <base-sha> to load the original owner/callers without changing
 * the checkout. Run fresh processes in AB/BA order; each owns synthetic state.
 * --mode turn-loop runs ten real sandbox finalizations per turn, with eight unchanged
 * commands and two synthetic guest edits. Only engine I/O is faked at execContainer.
 * Use --requests 5 --burst 1 --files 62000 --file-bytes 19050 --transcript-mib 35840;
 * --reuse-fixture reopens it for A/A and interleaved A/B runs. Each changed command
 * must publish its bytes before finalization returns. This is owner proof, not
 * native Podman/btrfs or model/Gateway latency. Engine pause delays are not simulated.
 * --native-turns --sandbox-backend podman replaces that seam with native Podman,
 * writes through podman exec, and verifies canonical plus subsequent guest reads.
 * --all-mutating writes on all ten commands per turn. Requires an existing local
 * --guest-image and task-private Podman store supplied by its normal environment.
 * Run on a btrfs fixture for native filesystem proof; pause durations conservatively
 * include pause/unpause CLI latency. Reports command latency plus finalization,
 * per-command main-process CPU and main-isolate allocation, and raw pause samples.
 * --mode file-read uses the same Gateway with a real Docker guest continuously
 * writing its private projection. Use --requests 30 --burst 1 --read-interval-ms 2000
 * --files 62000 --file-bytes 19050 for a minute of Control UI file reads. Reports
 * actual pause counts, guest heartbeat stalls, read latency, CPU and allocation.
 * --guest-image must already exist. The host filesystem is reported; a macOS
 * run is not btrfs/Podman evidence. No model or production state is involved.
 * Reuse the same owned fixture with --reuse-fixture --report <arm>.json; each
 * fresh process starts its own Gateway and guest and resets the freshness sentinel.
 * --mode gateway adds 10k session rows, 40 fixture plugins and 64 WebSocket
 * clients, then exercises sessions.files.list on the same managed workspace.
 * This is a focused source-Gateway reproduction, not the ten-minute dist stress
 * campaign. There are no model turns or operator/Team services in this workload.
 * Count lease acquisitions and manifest scans first; timing and main-thread
 * allocation include real storage dispatch. Every burst must have identical
 * results; a later guest write must be present after the next request.
 * The synthetic checkout uses a relative Git pointer and fixed file mtimes so
 * independently rooted fixtures return identical Files metadata.
 * --mode maintenance measures idle artifact sweeps through the real allocation
 * lease owner; --mode publication measures settled-workspace custody. Use
 * --lease-sources for a separate caller-stack census (never for timing).
 * --mode heartbeat retains one independent worker lease across the warm run;
 * each operation verifies and renews it. Acquisition and release are outside
 * its warm counts, as they are outside recurring heartbeat ticks.
 * Maintenance also holds this sibling lease so recurring sweeps share a warm
 * heartbeat carrier, as they do with other active owners on a busy Gateway.
 * --instrument retention samples memory after collecting the main isolate and
 * observed direct workers, outside timing/GC measurements. Use identical-code controls
 * to separate retained memory from different natural-GC/worker-idle schedules.
 * --retention-ms 120000 gives both revisions the same minimum elapsed time
 * after warmup before collection, including their normal idle-worker retirement.
 * These modes report 16 operations per simulated minute, not production rates.
 * --mode preparation calls prepareLocalSandboxWorkspace for concurrent turns on
 * one session-owned workspace, with 10k unrelated session rows. --files 62000
 * --file-bytes 19050 creates a ~1.1 GiB synthetic checkout. It measures the real
 * preparation owner, not Docker or a model. --transcript-mib seeds genuine
 * synthetic transcript payloads using the shared Team fixture; report DB bytes
 * separately because compression changes physical size. Filesystem is host-owned.
 * Compare --requests 8 --burst 8 in fresh-process A/A and interleaved A/B runs;
 * allocation is a separate instrumented pass. Later writes must still reconcile.
 * After the first preparation fixture, --reuse-fixture --report <name>.json
 * reopens that synthetic workspace in a fresh process. It resets the freshness
 * sentinel through canonical reconciliation before warmup; never run concurrently.
 * --serial-turns --mode preparation --burst 1 --requests 3 measures first creation,
 * three unchanged turns, one guest edit, an unchanged turn, 200 mixed guest edits,
 * and a final unchanged turn. --fixture-source <directory> imports a retained
 * synthetic deep workspace into a new owned Git repository. Original files stay untouched.
 * --freeze-source <new-directory> freezes all tracked source plus working changes;
 * add --revision <sha> for an exact committed source. Both arms use this benchmark.
 * --source-root <frozen-directory> executes there, including real worker entrypoints.
 * Installed dependencies are shared and must stay unchanged throughout comparison.
 * --owner-switch adds a second-worktree A/B/A ownership check after serial turns.
 * Serial reports include per-turn wall/CPU/allocation, phases, and compressed manifest
 * snapshot bytes. Physical SQLite read accounting is Linux-only; unavailable is null.
 * --agent-storage-dir puts only the fixture's agent database on another volume;
 * canonical and projected workspaces remain under --output. Report that topology.
 * --agent-db-fixture clones a closed, checkpointed synthetic session database before
 * preparation. Reuse one seed across fresh A/B workspaces; never pass production data.
 * --acceleration --sandbox-backend podman --sandbox-image <local-image> exercises
 * real dependency-template preparation on a supported filesystem. The image must
 * already exist; its offline pnpm install may fail and exercise source-only fallback.
 * --sibling-worktrees 2000 adds real, empty sibling checkouts and Git registrations.
 * --fresh-only skips guest edits; combine with --owner-switch for a second fresh
 * projection using the first preparation's template. Both creations are timed.
 * A public repository fixture should be exported with git archive at a pinned
 * revision before passing --fixture-source; never import a live operator workspace.
 * First creation has cold owner/template state, not an evicted OS page cache.
 * --fake-builder-removal-ms 36000 substitutes a process-backed Podman fixture:
 * creation, termination and removal have persistent engine state. The builder
 * ignores SIGTERM: stop waits its default ten-second grace (or --time), while
 * kill terminates immediately. Calls record argv and start/completion timestamps.
 * Use with --acceleration --sandbox-backend podman --serial-turns --fresh-only.
 * Installation takes the real source-only fallback. Registry/housekeeping and
 * filesystem preparation remain real; this does not qualify Podman or btrfs.
 * Run separate fresh processes in A/A then ABAB order, at least five per arm.
 * Retirement is nested inside template.build; never add those durations together.
 * --owner-switch checks that another session at the same commit reuses the template.
 * --restart-stage prepare|resume splits owner-switch proof across two actual processes.
 * Run prepare to build the original template and close its owners; resume reuses that
 * fixture and times other-first with empty process caches. Both use identical arguments.
 *
 * --head-advance cold|prewarm advances HEAD with identical source before that second
 * session. The prewarm arm runs the existing background preparation owner first;
 * its cost is reported separately. Compare two cold controls then five interleaved
 * pairs: request-path template builds must change from one to zero, checkout HEAD
 * must match, and prewarm plus request total cost must remain within measured spread.
 * --head-change source|lockfile makes that advance change a tracked source file or
 * the frozen lockfile. --expected-head-builds 0|1 checks incremental reuse versus
 * full rebuild. Compare fresh baseline and candidate dependency fingerprints outside
 * timing. --partial-clone uses a local blob:none origin for the fixture checkout.
 * --source-dependent-install adds a postinstall that copies the changed source
 * into node_modules: its marker must differ when an unsafe refresh skips hooks.
 * --crash-builder interrupts the fixture's outstanding rm after the first prepare,
 * then exits without finalizers. Reopen that same --output with --recover-builder
 * --fake-builder-removal-ms 36000 to prove startup cleanup from persisted state.
 * --creation-contender starts an unrelated real managed checkout when the first
 * cold template build begins. Its latency/phases and the combined owner cost
 * expose global allocation head-of-line blocking. Use --serial-turns --fresh-only
 * --acceleration with a native dependency fixture; run two identical controls
 * and five counterbalanced baseline/candidate pairs. Child CPU is excluded.
 * Add --owner-switch --head-advance cold to start the contender on other-first,
 * after warming both creation owners, while a new commit still needs a cold template.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.ts";
import type { DiagnosticEventInput } from "../../src/infra/diagnostic-events.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "freeze-source": { type: "string" },
    "source-root": { type: "string" },
    "fixture-source": { type: "string" },
    "serial-turns": { type: "boolean", default: false },
    "owner-switch": { type: "boolean", default: false },
    "restart-stage": { type: "string" },
    "creation-contender": { type: "boolean", default: false },
    "head-advance": { type: "string" },
    "head-change": { type: "string" },
    "expected-head-builds": { type: "string" },
    "partial-clone": { type: "boolean", default: false },
    "source-dependent-install": { type: "boolean", default: false },
    "fresh-only": { type: "boolean", default: false },
    acceleration: { type: "boolean", default: false },
    "sandbox-backend": { type: "string", default: "docker" },
    "sandbox-image": { type: "string" },
    "fake-builder-removal-ms": { type: "string" },
    "crash-builder": { type: "boolean", default: false },
    "recover-builder": { type: "boolean", default: false },
    "sibling-worktrees": { type: "string", default: "0" },
    revision: { type: "string" },
    mode: { type: "string", default: "owner" },
    "read-interval-ms": { type: "string", default: "2000" },
    "guest-image": { type: "string", default: "node:24-bookworm" },
    "native-turns": { type: "boolean", default: false },
    "all-mutating": { type: "boolean", default: false },
    requests: { type: "string", default: "2048" },
    burst: { type: "string", default: "64" },
    files: { type: "string", default: "1000" },
    "file-bytes": { type: "string", default: "0" },
    "transcript-mib": { type: "string", default: "0" },
    "agent-storage-dir": { type: "string" },
    "agent-db-fixture": { type: "string" },
    "reuse-fixture": { type: "boolean", default: false },
    report: { type: "string", default: "report.json" },
    port: { type: "string", default: "44984" },
    instrument: { type: "string", default: "timing" },
    absent: { type: "boolean", default: false },
    "lease-sources": { type: "boolean", default: false },
    worktrees: { type: "string", default: "64" },
    "retention-ms": { type: "string", default: "0" },
  },
});
const processInstance = randomUUID();
const harnessSha256 = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptRelative = "scripts/perf/local-workspace-checkpoint-measure.ts";
if (values["freeze-source"]) {
  const destination = path.resolve(values["freeze-source"]);
  fs.mkdirSync(destination);
  const revision = values.revision ?? "HEAD";
  const oid = execFileSync("git", ["rev-parse", revision], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const archive = execFileSync("git", ["archive", oid], { cwd: sourceRoot, maxBuffer: 1024 ** 3 });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive });
  // A candidate may be frozen before commit; only tracked working changes overlay HEAD.
  if (!values.revision) {
    const changed = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: sourceRoot })
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const relative of changed) {
      const from = path.join(sourceRoot, relative),
        to = path.join(destination, relative);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      } else {
        fs.rmSync(to, { force: true });
      }
    }
  }
  // Both arms execute this same measurement program, including its worker instrumentation.
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(destination, scriptRelative));
  fs.copyFileSync(
    new URL("./sandbox-builder-engine-fixture.ts", import.meta.url),
    path.join(destination, "scripts/perf/sandbox-builder-engine-fixture.ts"),
  );

  const digest = createHash("sha256");
  let fileCount = 0;
  const tracked = execFileSync("git", ["ls-tree", "-rz", "--name-only", oid], {
    cwd: sourceRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString()
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const linkDependencies = (relative: string) => {
    const original = path.join(sourceRoot, relative),
      frozen = path.join(destination, relative);
    if (!fs.existsSync(original)) {
      return;
    }
    fs.mkdirSync(frozen, { recursive: true });
    for (const entry of fs.readdirSync(original)) {
      const from = path.join(original, entry),
        to = path.join(frozen, entry);
      if (entry.startsWith("@") && !fs.lstatSync(from).isSymbolicLink()) {
        linkDependencies(path.join(relative, entry));
      } else {
        const resolved = fs.realpathSync(from);
        const local = path.relative(sourceRoot, resolved);
        const target =
          local === "" || local.startsWith("packages/") || local.startsWith("extensions/")
            ? path.join(destination, local)
            : resolved;
        fs.symlinkSync(target, to);
      }
    }
  };
  linkDependencies("node_modules");
  for (const relative of tracked.filter((name) => name.endsWith("/package.json"))) {
    linkDependencies(path.join(path.dirname(relative), "node_modules"));
  }
  for (const relative of tracked) {
    const filename = path.join(destination, relative);
    if (!fs.existsSync(filename) || !fs.lstatSync(filename).isFile()) {
      continue;
    }
    digest.update(relative).update(fs.readFileSync(filename));
    fileCount++;
  }
  fs.writeFileSync(
    path.join(destination, "checkpoint-source.json"),
    JSON.stringify(
      {
        revision: oid,
        workingOverlay: !values.revision,
        fileCount,
        sha256: digest.digest("hex"),
        sharedDependencies: path.join(sourceRoot, "node_modules"),
      },
      null,
      2,
    ),
  );
  console.log(destination);
  process.exit(0);
}
if (values["source-root"]) {
  const destination = path.resolve(values["source-root"]);
  assert(
    fs.existsSync(path.join(destination, "checkpoint-source.json")),
    "Source must be frozen by this benchmark",
  );
  const args = process.argv.slice(2);
  const index = args.indexOf("--source-root");
  assert(index >= 0, "Use --source-root <path>");
  args.splice(index, 2);
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv.map((arg) => arg.replace(sourceRoot, destination + path.sep)),
      path.join(destination, scriptRelative),
      ...args,
    ],
    { cwd: destination, stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}
assert(
  values.output &&
    [
      "owner",
      "gateway",
      "file-read",
      "turn-loop",
      "maintenance",
      "publication",
      "heartbeat",
      "preparation",
    ].includes(values.mode!),
);
assert(!values.absent || values.mode !== "owner");
const fileReads = values.mode === "file-read";
const turnLoop = values.mode === "turn-loop";
const nativeTurns = values["native-turns"];
assert(!nativeTurns || (turnLoop && values["sandbox-backend"] === "podman"));
assert(!values["all-mutating"] || turnLoop);
assert(!turnLoop || Number(values.burst) === 1);
const gatewayMode = values.mode === "gateway" || fileReads;
const readIntervalMs = Number(values["read-interval-ms"]);
assert(Number.isSafeInteger(readIntervalMs) && readIntervalMs >= 0);
assert(!fileReads || Number(values.burst) === 1);
const dockerHost = fileReads
  ? execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      encoding: "utf8",
    }).trim()
  : undefined;
const serialTurns = values["serial-turns"];
assert(
  !serialTurns ||
    (values.mode === "preparation" && Number(values.burst) === 1 && !values["reuse-fixture"]),
);
assert(!values["fixture-source"] || serialTurns);
assert(!values["owner-switch"] || serialTurns);
assert(!values["fresh-only"] || serialTurns);
assert(!values.acceleration || serialTurns);
assert(
  !values["head-change"] ||
    (values["head-advance"] && ["source", "lockfile"].includes(values["head-change"])),
);
assert(
  values["expected-head-builds"] === undefined ||
    ["0", "1"].includes(values["expected-head-builds"]),
);
assert(!values["partial-clone"] || serialTurns);
assert(!values["source-dependent-install"] || values["head-change"] === "source");
assert(
  !values["creation-contender"] ||
    (serialTurns &&
      values["fresh-only"] &&
      values.acceleration &&
      (!values["owner-switch"] || values["head-advance"] === "cold")),
);
assert(
  !values["head-advance"] ||
    (["cold", "prewarm"].includes(values["head-advance"]) &&
      values["owner-switch"] &&
      values["fresh-only"] &&
      values.acceleration),
);
assert(["docker", "podman"].includes(values["sandbox-backend"]));
assert(!values["sandbox-image"] || values.acceleration);
const fakeBuilderRemovalMs =
  values["fake-builder-removal-ms"] === undefined
    ? undefined
    : Number(values["fake-builder-removal-ms"]);
assert(
  fakeBuilderRemovalMs === undefined ||
    (Number.isSafeInteger(fakeBuilderRemovalMs) &&
      fakeBuilderRemovalMs >= 0 &&
      (values["recover-builder"] ||
        (values.acceleration && values["sandbox-backend"] === "podman"))),
);
assert(!(values["crash-builder"] && values["recover-builder"]));
assert(
  !(values["crash-builder"] || values["recover-builder"]) || fakeBuilderRemovalMs !== undefined,
);
const siblingWorktrees = Number(values["sibling-worktrees"]);
assert(Number.isSafeInteger(siblingWorktrees) && siblingWorktrees >= 0);
assert(!siblingWorktrees || serialTurns);
const resumeOwnerSwitch = values["restart-stage"] === "resume";
assert(
  !values["restart-stage"] ||
    (["prepare", "resume"].includes(values["restart-stage"]) &&
      serialTurns &&
      values["owner-switch"] &&
      values["fresh-only"] &&
      values.acceleration),
);
const reuseFixture = values["reuse-fixture"] || resumeOwnerSwitch;
assert(!reuseFixture || values.mode === "preparation" || fileReads || turnLoop);
const requests = Number(values.requests),
  burst = Number(values.burst),
  files = Number(values.files),
  port = Number(values.port),
  worktrees = Number(values.worktrees);
const fileBytes = Number(values["file-bytes"]);
assert(Number.isSafeInteger(fileBytes) && fileBytes >= 0);
const transcriptMiB = Number(values["transcript-mib"]);
assert(Number.isSafeInteger(transcriptMiB) && transcriptMiB >= 0);
assert(!values["agent-db-fixture"] || (serialTurns && !transcriptMiB));
assert(!transcriptMiB || values.mode === "preparation" || fileReads || turnLoop);
for (const value of [requests, burst, files, port, worktrees]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(port >= 40000 && port <= 65535);
assert(["timing", "allocation", "retention"].includes(values.instrument!));
const retentionMs = Number(values["retention-ms"]);
assert(Number.isSafeInteger(retentionMs) && retentionMs >= 0);
const workers = new Set<Worker>();
let workerStarts = 0,
  workerExits = 0;
const observeWorker = (worker: Worker) => {
  workerStarts++;
  workers.add(worker);
  worker.once("exit", () => {
    workerExits++;
    workers.delete(worker);
  });
};
if (values.instrument === "retention" || serialTurns) {
  if (values.instrument === "retention") {
    assert(globalThis.gc, "Retention samples require --expose-gc");
  }
  process.on("worker", observeWorker);
}
const sampleWorkerAllocation = async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await Promise.all(
      [...workers].map(async (worker) => ({
        threadId: worker.threadId,
        bytes: await worker.getHeapStatistics().then(
          (stats) => stats.total_allocated_bytes,
          () => null,
        ),
      })),
    );
  } finally {
    clearInterval(keepAlive);
  }
};
const collectRetainedMemory = async () => {
  assert(globalThis.gc, "Retention samples require --expose-gc");
  // Worker inspection promises do not retain the event loop after these pools unref their workers.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const workerHeaps = [];
    for (const worker of workers) {
      const profile = await worker.startHeapProfile({ forceGC: true });
      await profile.stop();
      workerHeaps.push({ threadId: worker.threadId, ...(await worker.getHeapStatistics()) });
    }
    globalThis.gc();
    return { ...process.memoryUsage(), workerHeaps };
  } finally {
    clearInterval(keepAlive);
  }
};
if (values["lease-sources"]) {
  Error.stackTraceLimit = 32;
}
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: reuseFixture || values["recover-builder"] });
for (const name of ["home", "tmp", "repo"]) {
  fs.mkdirSync(path.join(output, name), { recursive: reuseFixture || values["recover-builder"] });
}
if (values["agent-storage-dir"] && !reuseFixture) {
  const agentStorage = path.resolve(values["agent-storage-dir"]);
  fs.mkdirSync(agentStorage);
  fs.mkdirSync(path.join(output, "state"), { recursive: true });
  fs.symlinkSync(agentStorage, path.join(output, "state", "agents"), "dir");
}
if (values["agent-db-fixture"] && !resumeOwnerSwitch) {
  const destination = path.join(
    output,
    "state",
    "agents",
    "main",
    "agent",
    "openclaw-agent.sqlite",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const { prepareSqliteDatabaseDirectory } =
    await import("../../src/infra/sqlite-wal-filesystem.js");
  prepareSqliteDatabaseDirectory(destination);
  fs.copyFileSync(
    path.resolve(values["agent-db-fixture"]),
    destination,
    fs.constants.COPYFILE_FICLONE,
  );
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const owners = [
  "src/gateway/worker-environments/local-workspace-projection.ts",
  "src/gateway/worker-environments/local-workspace-state.ts",
  "src/gateway/worker-environments/local-workspace-checkpoint.ts",
  "src/gateway/worker-environments/local-workspace-manifest-scan.ts",
  "src/gateway/worker-environments/workspace-actual-manifest.ts",
  "src/agents/sandbox/local-workspace.ts",
  "src/agents/sandbox/local-workspace-quiescence.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/session-file-read.ts",
  "src/gateway/server-methods/session-files-root.ts",
  "src/gateway/server-methods/workspace-files.ts",
  "src/gateway/control-ui-assistant-media-read.ts",
  "src/gateway/worker-environments/local-workspace-checkout.ts",
  "src/gateway/worker-environments/local-workspace-store.kernel.ts",
  ...(!values.revision ? ["src/gateway/worker-environments/local-workspace-read.ts"] : []),
  "src/agents/worktrees/gc-artifacts.ts",
  "src/state/openclaw-state-lease-acquisition.ts",
];
const source = new Map(
  owners.map((file) => [
    file,
    values.revision
      ? execFileSync("git", ["show", `${values.revision}:${file}`], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        })
      : fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
let acquisitions = 0,
  scans = 0,
  probes = 0;
const custodyDurationsMs: number[] = [];
const containerCommands: string[] = [];
const finalizations: Array<{
  changed: boolean;
  durationMs: number;
  commandDurationMs: number;
  processCpuMs: number;
  allocatedBytes: number;
  pauses: number;
}> = [];
const pauseDurationsMs: number[] = [];
const checkpointPhases: Array<{
  name: string;
  durationMs: number;
  processCpuMs: number;
  allocatedBytes: number;
  pausedAtStart: boolean;
  pausedAtEnd: boolean;
}> = [];
let pauseBegan: number | undefined;
const nativeCommandFinished = (command: string, started: number, code: number) => {
  if (code !== 0) {
    return;
  }
  if (command === "pause") {
    pauseBegan = started;
  }
  if (command === "unpause" && pauseBegan !== undefined) {
    pauseDurationsMs.push(performance.now() - pauseBegan);
    pauseBegan = undefined;
  }
};
let fakePaused = false;
const fakeContainerId = "a".repeat(64);
const guestTicks: Array<{ at: number; gapMs: number }> = [];
const guestHeartbeats = new EventEmitter();
const nextGuestHeartbeat = () =>
  once(guestHeartbeats, "tick", { signal: AbortSignal.timeout(5_000) });
const manifestReads: Array<{ kind: string; target?: string; bytes: number }> = [];
const leaseSources = new Map<string, { scope: string; stack: string; calls: number }>();
Object.assign(globalThis, {
  __containerCommandMeasure: (command: string) => containerCommands.push(command),
  __nativeCommandFinished: nativeCommandFinished,
  __checkpointPhase: async (name: string, operation: () => Promise<unknown>) => {
    const started = performance.now();
    const pausedAtStart = pauseBegan !== undefined;
    const cpu = process.cpuUsage();
    const allocated = getHeapStatistics().total_allocated_bytes;
    try {
      return await operation();
    } finally {
      const used = process.cpuUsage(cpu);
      checkpointPhases.push({
        name,
        durationMs: performance.now() - started,
        processCpuMs: (used.user + used.system) / 1000,
        allocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
        pausedAtStart,
        pausedAtEnd: pauseBegan !== undefined,
      });
    }
  },
  __turnEngine: (args: string[]) => {
    containerCommands.push(args[0]!);
    if (args[0] === "pause") {
      assert(!fakePaused, "Cannot pause an already-paused fixture");
      fakePaused = true;
    } else if (args[0] === "unpause") {
      assert(fakePaused, "Cannot resume a running fixture");
      fakePaused = false;
    } else {
      assert.equal(args[0], "inspect", `Unexpected engine command: ${args.join(" ")}`);
    }
    return {
      code: 0,
      stderr: "",
      stdout:
        args[0] !== "inspect"
          ? ""
          : args[2] === "{{.State.Paused}}"
            ? String(fakePaused)
            : `${fakeContainerId} true ${fakePaused}`,
    };
  },
  __manifestReadMeasure: (action: { kind: string; target?: string }, bytes: number) =>
    manifestReads.push({ kind: action.kind, target: action.target, bytes }),
  __custodyDurationMeasure: (durationMs: number) => custodyDurationsMs.push(durationMs),
  __leaseSourceMeasure: (scope: string, stack: string) => {
    const key = JSON.stringify([scope, stack]);
    const entry = leaseSources.get(key) ?? {
      scope,
      stack: stack.replaceAll(root, "<source>"),
      calls: 0,
    };
    entry.calls++;
    leaseSources.set(key, entry);
  },
  __checkpointMeasure: (action?: string) => {
    if (action === "scan") {
      scans++;
    } else if (action === "probe") {
      probes++;
    } else if (action === undefined) {
      acquisitions++;
    }
  },
});
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    let code = source.get(relative);
    const phaseFunctions: Record<string, string[]> = {
      "src/gateway/worker-environments/workspace-manifest-worker.ts": ["computeWorkspaceManifest"],
      "src/gateway/worker-environments/workspace-result-staging.ts": [
        "stageWorkerWorkspaceResult",
        "withStagedWorkerWorkspaceManifest",
      ],
      "src/gateway/worker-environments/workspace-reconcile-apply.ts": [
        "applyStagedWorkerWorkspace",
      ],
    };
    if (nativeTurns && phaseFunctions[relative]) {
      code ??= fs.readFileSync(path.join(root, relative), "utf8");
      for (const name of phaseFunctions[relative]) {
        const sourceText: string = code;
        const exported = sourceText.includes(`export async function ${name}`);
        const anchor = `${exported ? "export " : ""}async function ${name}`;
        assert(sourceText.includes(anchor));
        code = sourceText.replace(anchor, `async function measured_${name}`);
        const phaseName =
          name === "computeWorkspaceManifest"
            ? `${JSON.stringify(name + ":")} + args[0].type`
            : JSON.stringify(name);
        code += `\n${exported ? "export " : ""}async function ${name}(...args) {
          return globalThis.__checkpointPhase(${phaseName}, () => measured_${name}(...args));
        }\n`;
      }
    }
    if (turnLoop && !nativeTurns && relative === "src/agents/sandbox/container-engine.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "export async function execContainer(";
      const start = code.indexOf(anchor);
      assert(start >= 0);
      const body = code.indexOf("  let result;", start);
      assert(body >= 0);
      code = code.slice(0, body) + "  return globalThis.__turnEngine(args);\n" + code.slice(body);
    }
    if (nativeTurns && relative === "src/agents/sandbox/container-engine.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "    result = await execContainerRaw(engine, args, opts);";
      assert(code.includes(anchor));
      code = code.replace(
        anchor,
        `    globalThis.__containerCommandMeasure(args[0]);
    const measurementStarted = performance.now();
${anchor}
    globalThis.__nativeCommandFinished(args[0], measurementStarted, result.code);`,
      );
    }
    if (fileReads && relative === "src/agents/sandbox/container-engine.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "let result;\n  try {";
      assert(code.includes(anchor));
      code = code.replace(anchor, "globalThis.__containerCommandMeasure(args[0]);\n" + anchor);
    }
    if (values["lease-sources"] && relative === "src/state/openclaw-state-lease.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor = "const validated = validateOpenClawStateLeaseOptions(invocation.options);";
      assert(code.includes(anchor));
      code = code.replace(
        anchor,
        anchor + "\nglobalThis.__leaseSourceMeasure(invocation.options.scope, new Error().stack);",
      );
    }
    if (relative === "src/gateway/worker-environments/local-workspace-store.ts") {
      code = fs.readFileSync(path.join(root, relative), "utf8");
      const anchor =
        'const readManifest: LocalWorkspaceStore["manifest"] = async (previous, action) => {';
      assert(code.includes(anchor));
      code = code.replace(
        "const env = params.env ?? process.env;",
        "globalThis.__checkpointMeasure();\nconst env = params.env ?? process.env;",
      );
      code = code.replace(anchor, anchor + "\nglobalThis.__checkpointMeasure(action.kind);");
      const snapshotAnchor = code.includes("return result.snapshot;")
        ? "return result.snapshot;"
        : "const value = await computeWorkspaceManifest(";
      assert(code.includes(snapshotAnchor));
      code = code.replace(
        snapshotAnchor,
        "globalThis.__manifestReadMeasure(action, result.snapshot.byteLength);\n" + snapshotAnchor,
      );
      assert(code.includes("(lease) => {") && code.includes("row = undefined;"));
      code = code.replace(
        "(lease) => {",
        "(lease) => {\nconst custodyStartedAt = performance.now();",
      );
      code = code.replace(
        "row = undefined;",
        "row = undefined;\nglobalThis.__custodyDurationMeasure(performance.now() - custodyStartedAt);",
      );
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
  caseEnv: {
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  },
});
const fakeBuilderEngine =
  fakeBuilderRemovalMs === undefined
    ? undefined
    : (await import("./sandbox-builder-engine-fixture.ts")).installSandboxBuilderEngineFixture(
        output,
        fakeBuilderRemovalMs,
        values["recover-builder"],
      );
if (values["recover-builder"]) {
  const recoveredConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
  (await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(recoveredConfig);
  const state = await import("../../src/state/openclaw-state-db.js");
  state.openOpenClawStateDatabase();
  const lifecycle = await import("../../src/agents/sandbox/registry-lifecycle.js");
  const before = fakeBuilderEngine!.snapshot();
  assert(before.remaining.length > 0, "Recovery needs a persisted interrupted builder");
  const started = performance.now(),
    cpuBefore = process.cpuUsage();
  const close = lifecycle.prepareSandboxRegistryClose();
  await lifecycle.maybeRunSandboxRegistryHousekeeping(async () => {});
  await close.drain();
  const cpu = process.cpuUsage(cpuBefore);
  const recovery = {
    before,
    after: fakeBuilderEngine!.snapshot(),
    elapsedMs: performance.now() - started,
    processCpuMs: (cpu.user + cpu.system) / 1000,
  };
  fs.writeFileSync(path.join(output, "builder-recovery.json"), JSON.stringify(recovery, null, 2));
  await state.closeOpenClawStateDatabaseAsync();
  assert.equal(recovery.after.remaining.length, 0, "Startup leaked an interrupted builder");
  console.log(JSON.stringify(recovery));
  process.exit(0);
}
const repo = path.join(output, "repo"),
  canonical = path.join(output, "canonical");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    env: values["head-change"]
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
        }
      : process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
if (reuseFixture && !resumeOwnerSwitch) {
  assert.equal(
    fs.readdirSync(repo).length - 1,
    files,
    "Reused fixture must have the requested file count",
  );
} else if (!resumeOwnerSwitch) {
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
  if (values["fixture-source"]) {
    const template = path.resolve(values["fixture-source"]);
    for (const name of fs.readdirSync(template)) {
      if (name === ".git" || name === "local-only-ignored.txt") {
        continue;
      }
      fs.cpSync(path.join(template, name), path.join(repo, name), {
        recursive: true,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    }
  } else {
    for (let i = 0; i < files; i++) {
      fs.writeFileSync(path.join(repo, `file-${i}.txt`), `synthetic ${i}\n`.padEnd(fileBytes, "."));
    }
    if (fakeBuilderEngine) {
      fs.writeFileSync(
        path.join(repo, "package.json"),
        '{"name":"synthetic-builder","private":true}\n',
      );
      fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }
  }
  // An exported repository may contain deliberately tracked ignored fixtures.
  git("add", ...(values["fixture-source"] ? ["--force"] : []), ".");
  if (values["source-dependent-install"]) {
    const input = git("ls-files", "src/").trim().split("\n")[0];
    assert(input, "Source-dependent install needs a tracked src/ file");
    const manifest = path.join(repo, "package.json");
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      scripts?: Record<string, string>;
    };
    pkg.scripts = {
      ...pkg.scripts,
      postinstall: `node -e 'require("node:fs").copyFileSync(${JSON.stringify(input)}, "node_modules/source-dependent.txt")'`,
    };
    fs.writeFileSync(manifest, JSON.stringify(pkg) + "\n");
    git("add", "package.json");
  }
  git("commit", "--quiet", "-m", "Synthetic workspace");
  if (values["fixture-source"]) {
    // Compare checkout bytes after Git's committed attributes have normalized the import.
    // Remove stat-clean imports too: checkout-index otherwise keeps their pre-filter bytes.
    for (const name of fs.readdirSync(repo).filter((entry) => entry !== ".git")) {
      fs.rmSync(path.join(repo, name), { recursive: true, force: true });
    }
    git("checkout-index", "--all", "--force");
  }
  if (values["partial-clone"]) {
    git("config", "uploadpack.allowFilter", "true");
    const upstream = path.join(output, "upstream");
    fs.renameSync(repo, upstream);
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", `file://${upstream}`, repo]);
    git("config", "user.name", "Synthetic fixture");
    git("config", "user.email", "fixture@example.invalid");
    assert.equal(git("config", "remote.origin.partialclonefilter").trim(), "blob:none");
  }
  git("worktree", "add", "--quiet", "-b", "fixture", canonical);
  for (let i = 0; i < siblingWorktrees; i++) {
    git(
      "worktree",
      "add",
      "--quiet",
      "--detach",
      "--no-checkout",
      path.join(output, "siblings", `worktree-${i}`),
      "HEAD",
    );
  }
}
if (reuseFixture && !resumeOwnerSwitch) {
  fs.writeFileSync(path.join(canonical, "file-0.txt"), "synthetic 0\n".padEnd(fileBytes, "."));
}
if (gatewayMode && !reuseFixture) {
  const pointerPath = path.join(canonical, ".git");
  const pointer = fs.readFileSync(pointerPath, "utf8");
  assert(pointer.startsWith("gitdir: "));
  fs.writeFileSync(pointerPath, `gitdir: ${path.relative(canonical, pointer.slice(8).trim())}\n`);
}
const plugins = gatewayMode ? writePluginFixtures(output, { count: 40 }) : undefined;
const config: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  worktreeAcceleration: values.acceleration,
  ...(fileReads ? { session: { maintenance: { mode: "warn" as const } } } : {}),
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    entries: { main: { workspace: repo } },
    defaults: {
      sandbox: {
        ...(values["head-advance"] || fileReads ? { mode: "all" as const } : {}),
        backend: values["sandbox-backend"],
        docker: { image: values["sandbox-image"] },
      },
    },
  },
  cron: { enabled: false },
  plugins: {
    enabled: true,
    allow: plugins?.pluginIds ?? [],
    load: { paths: plugins ? [plugins.pluginsDir] : [] },
    slots: { memory: "none" },
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
const sessionKey = "agent:main:dashboard:checkpoint-fixture";
const owner: LocalWorkspaceOwner = {
  agentId: "main",
  sessionKey,
  sessionId: "checkpoint-fixture",
  lifecycleRevision: null,
  assertCurrent() {},
  env: process.env,
  worktree: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "fixture",
    repoFingerprint: "fixture",
    repoRoot: repo,
    path: canonical,
    branch: "fixture",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  },
};
const projection =
  await import("../../src/gateway/worker-environments/local-workspace-projection.js");
const { prepareLocalSandboxWorkspace } =
  await import("../../src/agents/sandbox/local-workspace.js");
const { resolveSandboxConfigForAgent } = await import("../../src/agents/sandbox/config.js");
const { withDiagnosticsTimelineObserver } = await import("../../src/infra/diagnostics-timeline.js");
const { withWorktreePreparationTiming } =
  await import("../../src/agents/worktrees/preparation-timing.js");
const sandbox = resolveSandboxConfigForAgent(config, owner.agentId);
const state = await import("../../src/state/openclaw-state-db.js");
const agent = await import("../../src/state/openclaw-agent-db.js");
(await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(config);
state.openOpenClawStateDatabase();
const sandboxRegistryClose = fakeBuilderEngine
  ? (await import("../../src/agents/sandbox/registry-lifecycle.js")).prepareSandboxRegistryClose()
  : undefined;
if (values.mode !== "maintenance" && !reuseFixture) {
  await (
    await import("../../src/agents/worktrees/registry.js")
  ).insertRegistryWorktree(process.env, owner.worktree);
}
let workspace =
  serialTurns || values.absent || values.mode === "maintenance" || values.mode === "heartbeat"
    ? undefined
    : await projection.withLocalWorkspaceProjection(owner, (operations) => operations.prepare());
for (const directory of reuseFixture || serialTurns
  ? []
  : workspace
    ? [canonical, workspace]
    : [canonical]) {
  for (let i = 0; i < files; i++) {
    fs.utimesSync(path.join(directory, `file-${i}.txt`), 1_767_225_600, 1_767_225_600);
  }
}
if (gatewayMode) {
  fs.utimesSync(path.join(canonical, ".git"), 1_767_225_600, 1_767_225_600);
}
const checkpoint = () =>
  values.revision
    ? projection.withLocalWorkspaceProjection(owner, (operations) =>
        operations.synchronize("canonical"),
      )
    : projection.checkpointLocalWorkspace(owner);
const { collectRetiredWorktreeArtifacts } =
  await import("../../src/agents/worktrees/gc-artifacts.js");
const { WorktreeGcProgress } = await import("../../src/agents/worktrees/gc-progress.js");
const { withWorktreeAllocationLease } = await import("../../src/agents/worktrees/allocation.js");
// A populated default root with only registered checkouts is the recurring idle case.
const maintained: LocalWorkspaceOwner["worktree"][] = [];
if (values.mode === "maintenance") {
  const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  for (let i = 0; i < worktrees; i++) {
    const record = {
      ...owner.worktree,
      id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
      path: path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "worktrees",
        `repo-${i % 8}`,
        `registered-${i}`,
      ),
    };
    fs.mkdirSync(record.path, { recursive: true });
    await insertRegistryWorktree(process.env, record);
    maintained.push(record);
  }
}
let server:
  | Awaited<ReturnType<typeof import("../../src/gateway/server.js").startGatewayServer>>
  | undefined;
const clients: Array<import("../../src/gateway/client.js").GatewayClient> = [];
const handlerDurations: number[] = [];
let stopRpcDiagnostics = () => {};
let stopLeaseDiagnostics = () => {};
let turnProjection: Awaited<ReturnType<typeof prepareLocalSandboxWorkspace>>;
let guestName: string | undefined;
let guestProcess: ReturnType<typeof spawn> | undefined;
let guestExited: Promise<void> | undefined;
const endHeartbeat = Promise.withResolvers<void>();
let heartbeatDone: Promise<void> | undefined;
let heartbeatLease:
  | import("../../src/state/openclaw-state-lease.js").OpenClawStateAsyncLeaseContext
  | undefined;
measurement: try {
  if (values.mode === "heartbeat" || values.mode === "maintenance") {
    const ready = Promise.withResolvers<NonNullable<typeof heartbeatLease>>();
    const { withOpenClawStateLeaseAsync } = await import("../../src/state/openclaw-state-lease.js");
    const { captureOpenClawStateWorkerContext } =
      await import("../../src/state/openclaw-state-worker-context.js");
    heartbeatDone = withOpenClawStateLeaseAsync(
      {
        scope: "synthetic.heartbeat",
        key: "held",
        leaseMs: 600_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      captureOpenClawStateWorkerContext(),
      async (lease) => {
        ready.resolve(lease);
        await endHeartbeat.promise;
      },
    );
    void heartbeatDone.catch(ready.reject);
    heartbeatLease = await ready.promise;
  }
  if (!reuseFixture && (gatewayMode || values.mode === "preparation" || turnLoop)) {
    if (transcriptMiB) {
      const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
      const database = agent.openOpenClawAgentDatabase({ agentId: "main" });
      const progress = setInterval(() => {
        // Offline fixture writes use the existing owner to bound WAL growth, outside timing.
        database.walMaintenance.checkpoint();
        console.error(
          `Seeding synthetic transcript database: ${fs.statSync(database.path).size} bytes`,
        );
      }, 30_000);
      try {
        await seedTeamShapeSessions({
          stateDir: process.env.OPENCLAW_STATE_DIR!,
          sessions: 10_000,
          retainedRuns: 0,
          seed: 2039,
          now: 1_767_225_600_000,
          transcriptBytes: transcriptMiB * 1024 * 1024,
        });
      } finally {
        clearInterval(progress);
      }
    }
    const db = agent.openOpenClawAgentDatabase({ agentId: "main" });
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    agent.runOpenClawAgentWriteTransaction(
      (writer) => {
        for (let i = 0; i < (transcriptMiB || values["agent-db-fixture"] ? 0 : 10_000); i++) {
          writeSessionEntry(writer, `agent:main:subagent:fixture-${i}`, {
            sessionId: `fixture-${i}`,
            updatedAt: 1,
            label: `Synthetic ${i}`,
          });
        }
        writeSessionEntry(writer, sessionKey, {
          sessionId: owner.sessionId,
          updatedAt: 1,
          spawnedCwd: canonical,
          worktree: { id: owner.worktree.id, branch: owner.worktree.branch, repoRoot: repo },
        });
      },
      { agentId: "main", path: db.path },
    );
    await agent.closeOpenClawAgentDatabasesAsync();
  }
  let runTurn: (() => Promise<void>) | undefined;
  if (turnLoop) {
    assert(workspace);
    const { bindLocalSandboxWorkspace } =
      await import("../../src/agents/sandbox/local-workspace.js");
    const { createSandboxTestContext } = await import("../../src/agents/sandbox/test-fixtures.js");
    const { createHostSandboxFsBridge } =
      await import("../../src/agents/test-helpers/host-sandbox-fs-bridge.js");
    if (nativeTurns) {
      guestName = `openclaw-checkpoint-measure-${process.pid}`;
      execFileSync("podman", ["image", "inspect", values["guest-image"]], { stdio: "ignore" });
      execFileSync(
        "podman",
        [
          "run",
          "--detach",
          "--name",
          guestName,
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--mount",
          `type=bind,source=${workspace},target=/workspace`,
          values["guest-image"],
          "sleep",
          "infinity",
        ],
        { stdio: "ignore" },
      );
    }
    const turnRuntime = guestName ?? "synthetic-turn";
    const backend: import("../../src/agents/sandbox/backend-handle.types.js").SandboxBackendHandle =
      {
        id: nativeTurns ? "podman" : "docker",
        runtimeId: turnRuntime,
        runtimeLabel: turnRuntime,
        workdir: "/workspace",
        buildExecSpec: async () => ({ argv: [], env: {}, stdinMode: "pipe-closed" }),
        runShellCommand: async () => {
          throw new Error("Unexpected bridge command");
        },
      };
    turnProjection = await prepareLocalSandboxWorkspace({
      cfg: config,
      agentId: owner.agentId,
      sessionKey,
      workspaceDir: canonical,
      sandbox,
    });
    assert(turnProjection, "Turn must retain the real workspace owner");
    const context = createSandboxTestContext({
      overrides: {
        backend,
        workspaceDir: workspace,
        fsBridge: createHostSandboxFsBridge(workspace),
      },
    });
    bindLocalSandboxWorkspace(context, turnProjection);
    await (
      await import("../../src/agents/sandbox/registry.js")
    ).updateRegistry({
      containerName: turnRuntime,
      backendId: nativeTurns ? "podman" : "docker",
      backendTarget: nativeTurns
        ? (
            await (
              await import("../../src/agents/sandbox/podman-runtime.js")
            ).resolvePodmanSandboxRuntimeInfo()
          ).target
        : undefined,
      sessionKey,
      workspaceDir: workspace,
      workspaceSource: "managed-worktree",
      image: "synthetic",
      createdAtMs: 1,
      lastUsedAtMs: 1,
    });
    let edit = 0;
    runTurn = async () => {
      for (let tool = 0; tool < 10; tool++) {
        const commandBegan = performance.now();
        const commandCpu = process.cpuUsage();
        const commandAllocated = getHeapStatistics().total_allocated_bytes;
        const beforePauses = containerCommands.filter((command) => command === "pause").length;
        const spec = await backend.buildExecSpec({ command: "synthetic", env: {}, usePty: false });
        const editedFile = Math.floor((files * (tool === 4 ? 1 : 2)) / 3);
        const relative = `file-${editedFile}.txt`;
        const content =
          values["all-mutating"] || tool === 4 || tool === 9
            ? `synthetic edit ${++edit}\n`
            : undefined;
        if (content) {
          assert(!fakePaused, "Guest command cannot write while frozen");
          if (nativeTurns) {
            execFileSync("podman", [
              "exec",
              turnRuntime,
              "sh",
              "-c",
              'printf "%s" "$1" > "$2"',
              "sh",
              content,
              `/workspace/${relative}`,
            ]);
          } else {
            fs.writeFileSync(path.join(workspace!, relative), content);
          }
        }
        const began = performance.now();
        await backend.finalizeExec!({
          status: "completed",
          exitCode: 0,
          timedOut: false,
          token: spec.finalizeToken,
        });
        const finalizationEnded = performance.now();
        const usedCpu = process.cpuUsage(commandCpu);
        finalizations.push({
          changed: Boolean(content),
          durationMs: finalizationEnded - began,
          commandDurationMs: finalizationEnded - commandBegan,
          processCpuMs: (usedCpu.user + usedCpu.system) / 1000,
          allocatedBytes: getHeapStatistics().total_allocated_bytes - commandAllocated,
          pauses: containerCommands.filter((command) => command === "pause").length - beforePauses,
        });
        assert(!fakePaused, "Finalization must resume the guest");
        if (content) {
          assert.equal(fs.readFileSync(path.join(canonical, relative), "utf8"), content);
          if (nativeTurns) {
            assert.equal(
              execFileSync("podman", ["exec", turnRuntime, "cat", `/workspace/${relative}`], {
                encoding: "utf8",
              }),
              content,
              "The next guest read must see the completed command's saved bytes",
            );
          }
        }
      }
    };
  }
  if (fileReads) {
    assert(workspace);
    guestName = `openclaw-read-measure-${process.pid}`;
    const image = values["guest-image"];
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        guestName,
        "--network",
        "none",
        "--mount",
        `type=bind,source=${workspace},target=/workspace`,
        image,
        "sleep",
        "infinity",
      ],
      { stdio: "ignore" },
    );
    await (
      await import("../../src/agents/sandbox/registry.js")
    ).updateRegistry({
      containerName: guestName,
      backendId: "docker",
      sessionKey,
      workspaceDir: workspace,
      workspaceSource: "managed-worktree",
      image,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
    });
  }
  if (fileReads || nativeTurns) {
    assert(guestName);
    const ready = Promise.withResolvers<void>();
    guestProcess = spawn(
      nativeTurns ? "podman" : "docker",
      [
        "exec",
        guestName,
        "node",
        "-e",
        `
      const fs = require("node:fs");
      let last = performance.now(), tick = 0;
      setInterval(() => {
        const now = performance.now();
        if (${fileReads}) fs.writeFileSync("/workspace/writer.txt", "guest write " + (++tick));
        process.stdout.write(JSON.stringify({ gapMs: now - last }) + "\\n");
        last = now;
      }, 20);
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pending = "";
    guestProcess.stdout!.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const tick = JSON.parse(pending.slice(0, end)) as { gapMs: number };
        guestTicks.push({ at: performance.now(), gapMs: tick.gapMs });
        guestHeartbeats.emit("tick");
        pending = pending.slice(end + 1);
        ready.resolve();
      }
    });
    let guestError = "";
    guestProcess.stderr!.on("data", (chunk: Buffer) => {
      guestError += chunk.toString();
    });
    guestExited = new Promise((resolve) => {
      guestProcess!.once("exit", () => resolve());
    });
    guestProcess.once("error", (error) => ready.reject(error));
    guestProcess.once("exit", () => ready.reject(new Error(guestError || "Guest process exited")));
    await ready.promise;
  }
  if (gatewayMode) {
    await state.closeOpenClawStateDatabaseAsync();
    server = await (
      await import("../../src/gateway/server.js")
    ).startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
    const { GatewayClient } = await import("../../src/gateway/client.js");
    for (let i = 0; i < burst; i++) {
      const ready = Promise.withResolvers<void>();
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        clientName: "openclaw-control-ui",
        mode: "webchat",
        platform: "web",
        instanceId: `checkpoint-${i}`,
        scopes: ["operator.admin"],
        requestTimeoutMs: 600_000,
        onHelloOk: () => ready.resolve(),
        onConnectError: (error) => ready.reject(error),
      });
      clients.push(client);
      client.start();
      await ready.promise;
    }
  }
  const sweep = async () => {
    const progress = new WorktreeGcProgress();
    const result = await collectRetiredWorktreeArtifacts({
      env: process.env,
      records: maintained,
      expiresBefore: 0,
      progress,
      orphanFailures: new Map(),
      withAllocationLease: (run) => withWorktreeAllocationLease({ env: process.env }, run),
    });
    assert.equal(
      progress.result.outcome,
      "completed",
      "A failed sweep is not a performance sample",
    );
    assert.equal(progress.result.issueCount, 0);
    assert.deepEqual(result, { orphansDeleted: 0, snapshotsPruned: 0 });
    return result;
  };
  const prepareWorkspace = async () => {
    using prepared = await prepareLocalSandboxWorkspace({
      cfg: config,
      agentId: owner.agentId,
      sessionKey,
      workspaceDir: canonical,
      sandbox,
    });
    assert(prepared, "Preparation must resolve the selected session-owned workspace");
    workspace ??= prepared.workspaceDir;
    assert.equal(
      prepared.workspaceDir,
      workspace,
      "Preparation must reuse the selected projection",
    );
    return prepared.workspaceDir;
  };
  const runOne = (i: number) =>
    turnLoop
      ? runTurn!()
      : gatewayMode
        ? clients[i % clients.length]!.request(
            fileReads ? "sessions.files.get" : "sessions.files.list",
            { sessionKey, ...(fileReads ? { path: `/workspace/file-${i % files}.txt` } : {}) },
          )
        : values.mode === "preparation"
          ? prepareWorkspace()
          : values.mode === "maintenance"
            ? sweep()
            : values.mode === "publication"
              ? projection.withSettledLocalWorkspace(
                  { worktree: owner.worktree, env: process.env },
                  async () => {},
                )
              : values.mode === "heartbeat"
                ? heartbeatLease!.assertOwned().then(() => heartbeatLease!.renew())
                : checkpoint();
  if (serialTurns) {
    const { snapshotSqliteReaderMetrics } =
      await import("../../src/infra/sqlite-reader-metrics.js");
    const inventory = git("ls-files", "-z").split("\0").filter(Boolean).toSorted();
    const regularFiles: string[] = [];
    const initialBytes = inventory.reduce((sum, entry) => {
      const stat = fs.lstatSync(path.join(canonical, entry));
      if (stat.isFile()) {
        regularFiles.push(entry);
      }
      return sum + stat.size;
    }, 0);
    assert(regularFiles.length >= 201, "Serial scenario requires at least 201 regular files");
    const readFixtureEntry = (directory: string, entry: string) => {
      const filename = path.join(directory, entry);
      return fs.lstatSync(filename).isSymbolicLink()
        ? { kind: "symlink", content: Buffer.from(fs.readlinkSync(filename)) }
        : { kind: "file", content: fs.readFileSync(filename) };
    };
    const sentinel = ".lane2112-local-only";
    fs.appendFileSync(path.join(repo, ".git/info/exclude"), `\n${sentinel}\n`);
    fs.writeFileSync(path.join(canonical, sentinel), "canonical-only excluded bytes\n");
    const turns: unknown[] = [];
    const mutations = new Map<string, string | null>();
    let createContender: (() => Promise<unknown>) | undefined;
    if (values["creation-contender"]) {
      const contenderRepo = path.join(output, "contender-repo");
      fs.mkdirSync(contenderRepo);
      const contenderGit = (...args: string[]) =>
        execFileSync("git", ["-C", contenderRepo, ...args], { env: process.env });
      contenderGit("init", "--quiet", "-b", "main");
      contenderGit("config", "user.name", "Synthetic fixture");
      contenderGit("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(contenderRepo, "README.md"), "independent checkout\n");
      contenderGit("add", ".");
      contenderGit("commit", "--quiet", "-m", "Synthetic contender");
      const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
      const service = new ManagedWorktreeService({ getConfig: () => config });
      if (values["owner-switch"]) {
        await service.create({ repoRoot: contenderRepo, name: "warmup", baseRef: "HEAD" });
      }
      createContender = async () => {
        const spans: Record<string, number> = {};
        const started = performance.now();
        const record = await withDiagnosticsTimelineObserver(
          (name, _attributes, duration) => {
            const begin = performance.now();
            return () => {
              spans[name] = (spans[name] ?? 0) + (duration ?? performance.now() - begin);
            };
          },
          () => service.create({ repoRoot: contenderRepo, name: "contender", baseRef: "HEAD" }),
        );
        const elapsedMs = performance.now() - started;
        assert.equal(
          fs.readFileSync(path.join(record.path, "README.md"), "utf8"),
          "independent checkout\n",
        );
        return { elapsedMs, spans };
      };
    }
    const measureTurn = async (phase: string, prepare = prepareWorkspace) => {
      acquisitions = scans = probes = 0;
      manifestReads.length = 0;
      const workerStartsBefore = workerStarts,
        workerExitsBefore = workerExits;
      const workerAllocationBefore =
        values.instrument === "allocation" ? await sampleWorkerAllocation() : undefined;
      const gitOperations: Record<string, number> = {};
      const gitDiagnostics = channel("openclaw.git.operation");
      const observeGitOperation = (message: unknown) => {
        const { operation } = message as { operation: string };
        gitOperations[operation] = (gitOperations[operation] ?? 0) + 1;
      };
      gitDiagnostics.subscribe(observeGitOperation);
      const physicalBefore = snapshotSqliteReaderMetrics();
      const spans: Record<string, { count: number; totalMs: number }> = {};
      const loop = monitorEventLoopDelay({ resolution: 1 });
      loop.enable();
      const loadBefore = loadavg(),
        cpuBefore = process.threadCpuUsage(),
        totalBefore = process.cpuUsage();
      const allocationBefore = getHeapStatistics().total_allocated_bytes;
      const started = performance.now();
      const buildStarted = Promise.withResolvers<void>();
      let contenderStarted = false;
      // Construct this continuation outside preparation's closure-bound authority.
      const contender =
        phase === (values["owner-switch"] ? "other-first" : "first") && createContender
          ? buildStarted.promise.then(createContender)
          : undefined;
      void contender?.catch(() => {});
      const measuredWorkspace = await withDiagnosticsTimelineObserver(
        (name, _attributes, durationMs) => {
          if (
            contender &&
            name.endsWith(".template.build") &&
            durationMs === undefined &&
            !contenderStarted
          ) {
            contenderStarted = true;
            buildStarted.resolve();
          }
          const begin = performance.now();
          return () => {
            const span = (spans[name] ??= { count: 0, totalMs: 0 });
            span.count++;
            span.totalMs += durationMs ?? performance.now() - begin;
          };
        },
        () => withWorktreePreparationTiming("sandbox", prepare),
      ).catch(async (error: unknown) => {
        gitDiagnostics.unsubscribe(observeGitOperation);
        if (contenderStarted) {
          await Promise.allSettled([contender]);
        }
        throw error;
      });
      const projectionElapsedMs = performance.now() - started;
      assert(!contender || contenderStarted, "Cold template build never started contender");
      const contenderResult = await contender;
      const elapsedMs = performance.now() - started;
      const cpu = process.threadCpuUsage(cpuBefore),
        total = process.cpuUsage(totalBefore);
      const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationBefore;
      loop.disable();
      gitDiagnostics.unsubscribe(observeGitOperation);
      const readMetrics = snapshotSqliteReaderMetrics().map((metric) => {
        const previous = physicalBefore.find((entry) => entry.operation === metric.operation);
        return {
          operation: metric.operation,
          count: metric.count - (previous?.count ?? 0),
          readBytes: metric.readBytes - (previous?.readBytes ?? 0),
        };
      });
      const workerAllocationAfter = workerAllocationBefore
        ? await sampleWorkerAllocation()
        : undefined;
      const result = {
        phase,
        elapsedMs,
        ...(contender ? { projectionElapsedMs, contender: contenderResult } : {}),
        mainCpuMs: (cpu.user + cpu.system) / 1000,
        processCpuMs: (total.user + total.system) / 1000,
        allocatedBytes,
        gitOperations,
        workerAllocation:
          workerAllocationBefore && workerAllocationAfter
            ? {
                before: workerAllocationBefore,
                after: workerAllocationAfter,
                started: workerStarts - workerStartsBefore,
                exited: workerExits - workerExitsBefore,
                matchedAllocatedBytes: workerAllocationAfter.reduce((sum, after) => {
                  const before = workerAllocationBefore.find(
                    (entry) => entry.threadId === after.threadId,
                  );
                  return (
                    sum +
                    (before?.bytes != null && after.bytes != null ? after.bytes - before.bytes : 0)
                  );
                }, 0),
                accounting:
                  "Delta covers only workers sampled at both boundaries; new-worker values are lifetime totals. Exited or unavailable workers are unmeasured.",
              }
            : undefined,
        eventLoopP99Ms: loop.percentile(99) / 1e6,
        eventLoopMaxMs: loop.max / 1e6,
        eventLoopSamples: loop.count,
        acquisitions,
        scans,
        probes,
        manifestReads: [...manifestReads],
        manifestSnapshotBytes: manifestReads.reduce((sum, read) => sum + read.bytes, 0),
        physicalReaderMetrics: process.platform === "linux" ? readMetrics : null,
        hostLoad: loadBefore,
        hostLoadAfter: loadavg(),
        spans,
        ...(fakeBuilderEngine ? { engine: fakeBuilderEngine.snapshot() } : {}),
      };
      turns.push(result);
      console.log(JSON.stringify(result));
      if (values.acceleration && (phase === "first" || phase === "other-first")) {
        assert(
          spans["worktree.sandbox.templateApply"],
          "Requested template proof fell back before cloning; check filesystem, lockfile, and image",
        );
      }
      if (values["head-advance"] && phase === "other-first") {
        assert.equal(
          spans["attempt.setup.sandbox.workspace_selection.prepare.reconcile.template.build"]
            ?.count ?? 0,
          values["expected-head-builds"] === undefined
            ? values["head-advance"] === "cold"
              ? 1
              : 0
            : Number(values["expected-head-builds"]),
          "Fresh request template build count must match the selected proof arm",
        );
      }
      if (prepare !== prepareWorkspace) {
        return measuredWorkspace;
      }
      assert(workspace);
      assert.equal(
        fs.readFileSync(path.join(canonical, sentinel), "utf8"),
        "canonical-only excluded bytes\n",
      );
      assert(
        !fs.existsSync(path.join(workspace, sentinel)),
        "Host-only ignored bytes must not enter guest projection",
      );
      for (const [entry, content] of mutations) {
        for (const directory of [canonical, workspace]) {
          if (content === null) {
            assert(!fs.existsSync(path.join(directory, entry)), `Removed file survived: ${entry}`);
          } else {
            assert.equal(fs.readFileSync(path.join(directory, entry), "utf8"), content);
          }
        }
      }
      return measuredWorkspace;
    };
    if (resumeOwnerSwitch) {
      workspace = fs.readFileSync(path.join(output, "restart-projection.txt"), "utf8");
    } else {
      await measureTurn("first");
    }
    if (values["crash-builder"]) {
      const interruptedPids = await fakeBuilderEngine!.interruptRemoval();
      const crash = { turns, interruptedPids, engine: fakeBuilderEngine!.snapshot() };
      fs.writeFileSync(path.join(output, "builder-crash.json"), JSON.stringify(crash, null, 2));
      console.log(JSON.stringify({ builderCrash: crash }));
      process.exit(0);
    }
    for (let i = 0; i < (resumeOwnerSwitch ? 0 : requests); i++) {
      await measureTurn(`unchanged-${i + 1}`);
    }
    const modify = (entry: string, content: string | null) => {
      assert(workspace);
      mutations.set(entry, content);
      const filename = path.join(workspace, entry);
      if (content === null) {
        fs.unlinkSync(filename);
      } else {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
      }
    };
    if (!values["fresh-only"]) {
      modify(regularFiles[0]!, "one changed guest file\n");
      await measureTurn("changed-1");
      await measureTurn("post-edit-1");
      for (let i = 1; i <= 200; i++) {
        if (i <= 20) {
          modify(regularFiles[i]!, null);
        } else if (i <= 40) {
          modify(`lane2112-additions/deep/added-${i}.txt`, `added ${i}\n`);
        } else {
          modify(regularFiles[i]!, `changed ${i}\n`);
        }
      }
      await measureTurn("changed-200");
      await measureTurn("post-edit-200");
    }
    // Validate every retained/changed byte after all timing; no full-content validation warms later turns.
    const fingerprint = createHash("sha256");
    for (const entry of [...new Set([...inventory, ...mutations.keys()])].toSorted()) {
      if (mutations.get(entry) === null) {
        continue;
      }
      const expected = mutations.has(entry)
        ? { kind: "file", content: Buffer.from(mutations.get(entry)!) }
        : readFixtureEntry(repo, entry);
      assert.deepEqual(readFixtureEntry(canonical, entry), expected);
      assert.deepEqual(readFixtureEntry(workspace!, entry), expected);
      fingerprint.update(entry).update(expected.kind).update(expected.content);
    }
    if (values["restart-stage"] === "prepare") {
      fs.writeFileSync(path.join(output, "restart-projection.txt"), workspace!);
      fs.writeFileSync(
        path.join(output, "restart-preparation.json"),
        JSON.stringify({ processInstance, turns }),
      );
      break measurement;
    }
    const ownerSwitch: Array<{
      owner: string;
      snapshotBytes: number;
      reads: typeof manifestReads;
    }> = [];
    let advancedTree: string | undefined;
    let advancedCommit: string | undefined;
    let dependencyFingerprint: string | undefined;
    let dependencyFiles = 0;
    let dependencyBytes = 0;
    let sourceDependentInstallMatches: boolean | undefined;
    if (values["owner-switch"]) {
      if (values["head-advance"]) {
        const changed =
          values["head-change"] === "lockfile"
            ? "pnpm-lock.yaml"
            : regularFiles.find((entry) => entry.startsWith("src/"));
        if (values["head-change"]) {
          assert(changed, "Source-change proof needs a tracked src/ file");
          fs.appendFileSync(
            path.join(repo, changed),
            values["head-change"] === "lockfile"
              ? "\n# Synthetic HEAD advance\n"
              : "\n// Synthetic HEAD advance\n",
          );
          git("add", "--", changed);
        }
        git("commit", "--quiet", "--allow-empty", "-m", "Synthetic HEAD advance");
        if (values["head-advance"] === "prewarm") {
          const { prewarmLocalWorkspaceTemplates } =
            await import("../../src/gateway/worker-environments/local-workspace-prewarm.js");
          await measureTurn("head-prewarm", async () => {
            await prewarmLocalWorkspaceTemplates({
              getConfig: () => config,
              signal: new AbortController().signal,
            });
            return repo;
          });
        }
      }
      const registerFreshOwner = async (name: string, id: string) => {
        const otherKey = `${sessionKey}:${name}`;
        const otherCanonical = path.join(output, `${name}-canonical`);
        git("worktree", "add", "--quiet", "-b", name, otherCanonical);
        const otherWorktree = {
          ...owner.worktree,
          id,
          path: otherCanonical,
          branch: name,
          ownerId: otherKey,
        };
        await (
          await import("../../src/agents/worktrees/registry.js")
        ).insertRegistryWorktree(process.env, otherWorktree);
        const { writeSessionEntry } =
          await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
        const database = agent.openOpenClawAgentDatabase({ agentId: "main" });
        agent.runOpenClawAgentWriteTransaction(
          (writer) => {
            writeSessionEntry(writer, otherKey, {
              sessionId: `checkpoint-${name}`,
              updatedAt: 1,
              spawnedCwd: otherCanonical,
              worktree: { id: otherWorktree.id, branch: name, repoRoot: repo },
            });
          },
          { agentId: "main", path: database.path },
        );
        return { sessionKey: otherKey, canonical: otherCanonical };
      };
      const { sessionKey: otherKey, canonical: otherCanonical } = await registerFreshOwner(
        "other",
        "22222222-2222-4222-8222-222222222222",
      );
      let otherProjection: string | undefined;
      for (const selected of [
        "other-first",
        "other-warm",
        "original-return",
        "original-warm",
        "other-return",
      ]) {
        manifestReads.length = 0;
        const other = selected.startsWith("other");
        const preparedWorkspace = await measureTurn(selected, async () => {
          using prepared = await prepareLocalSandboxWorkspace({
            cfg: config,
            agentId: "main",
            sessionKey: other ? otherKey : sessionKey,
            workspaceDir: other ? otherCanonical : canonical,
            sandbox,
          });
          assert(prepared);
          return prepared.workspaceDir;
        });
        if (other) {
          otherProjection = preparedWorkspace;
        }
        const expected =
          other || values["fresh-only"]
            ? readFixtureEntry(repo, regularFiles[0]!)
            : { kind: "file", content: Buffer.from(mutations.get(regularFiles[0]!)!) };
        assert.deepEqual(
          readFixtureEntry(preparedWorkspace, regularFiles[0]!),
          expected,
          "A different owner's retained tree must not supply this workspace's bytes",
        );
        ownerSwitch.push({
          owner: selected,
          snapshotBytes: manifestReads.reduce((sum, read) => sum + read.bytes, 0),
          reads: [...manifestReads],
        });
      }
      let postRestartProjection: string | undefined;
      if (resumeOwnerSwitch) {
        const fresh = await registerFreshOwner(
          "post-restart",
          "33333333-3333-4333-8333-333333333333",
        );
        postRestartProjection = await measureTurn("post-restart-warm", async () => {
          using prepared = await prepareLocalSandboxWorkspace({
            cfg: config,
            agentId: "main",
            sessionKey: fresh.sessionKey,
            workspaceDir: fresh.canonical,
            sandbox,
          });
          assert(prepared);
          return prepared.workspaceDir;
        });
      }
      assert(otherProjection);
      for (const checkedProjection of [otherProjection, postRestartProjection].filter(
        (entry): entry is string => Boolean(entry),
      )) {
        assert(
          !fs.existsSync(path.join(checkedProjection, sentinel)),
          "Ignored host file entered fresh projection",
        );
        assert.equal(
          execFileSync("git", ["-C", checkedProjection, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          git("rev-parse", "HEAD").trim(),
          "Fresh projection must retain the selected checkout commit",
        );
        for (const entry of inventory) {
          assert.deepEqual(
            readFixtureEntry(checkedProjection, entry),
            readFixtureEntry(repo, entry),
            `Fresh template projection differs from its committed source: ${entry}`,
          );
        }
      }
      advancedTree = git("rev-parse", "HEAD^{tree}").trim();
      advancedCommit = git("rev-parse", "HEAD").trim();
      assert.equal(
        execFileSync("git", ["-C", otherProjection, "rev-parse", "HEAD^{tree}"], {
          encoding: "utf8",
        }).trim(),
        advancedTree,
      );
      const dependencies = createHash("sha256");
      const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory).toSorted()) {
          if (entry === ".git") {
            continue;
          }
          const target = path.join(directory, entry);
          const stat = fs.lstatSync(target);
          const relative = path.relative(otherProjection!, target);
          if (stat.isDirectory()) {
            walk(target);
          } else if (relative.split(path.sep).includes("node_modules")) {
            dependencies.update(relative).update(String(stat.mode & 0o777));
            let content = stat.isSymbolicLink()
              ? Buffer.from(fs.readlinkSync(target))
              : fs.readFileSync(target);
            dependencyFiles++;
            dependencyBytes += content.length;
            // pnpm's install/validation times are metadata, not dependency-tree content.
            if (entry === ".modules.yaml" || entry === ".pnpm-workspace-state-v1.json") {
              content = Buffer.from(
                content
                  .toString()
                  .replace(
                    /^(\s*"?(?:prunedAt|lastValidatedTimestamp|recordedAtNs|mtimeNs|ctimeNs)"?:).*$/gmu,
                    "$1 <timestamp>",
                  ),
              );
            }
            dependencies.update(content);
          }
        }
      };
      walk(otherProjection);
      dependencyFingerprint = dependencies.digest("hex");
      if (values["source-dependent-install"]) {
        sourceDependentInstallMatches = fs
          .readFileSync(path.join(otherProjection, "node_modules/source-dependent.txt"))
          .equals(
            fs.readFileSync(
              path.join(
                repo,
                regularFiles.find((entry) => entry.startsWith("src/"))!,
              ),
            ),
          );
      }
    }
    const sourceFile = path.join(root, "checkpoint-source.json");
    const result = {
      mode: "serial-preparation",
      fixture: {
        files: inventory.length,
        bytes: initialBytes,
        source: values["fixture-source"] ?? null,
        agentDatabase: values["agent-db-fixture"] ?? null,
        siblingWorktrees,
        acceleration: values.acceleration,
        headAdvance: values["head-advance"] ?? null,
        restartStage: values["restart-stage"] ?? null,
        processInstance,
        headChange: values["head-change"] ?? null,
        partialClone: values["partial-clone"],
        sourceDependentInstall: values["source-dependent-install"],
        sandboxBackend: sandbox.backend,
        sandboxImage: sandbox.docker.image,
        fakeBuilderRemovalMs,
        filesystemType: fs.statfsSync(output).type,
        pageCache: "not evicted by this benchmark",
      },
      source: fs.existsSync(sourceFile)
        ? (JSON.parse(fs.readFileSync(sourceFile, "utf8")) as unknown)
        : { revision: values.revision ?? "working-tree" },
      turns,
      ownerSwitch,
      fingerprint: fingerprint.digest("hex"),
      advancedTree,
      advancedCommit,
      dependencyFingerprint,
      dependencyFiles,
      dependencyBytes,
      sourceDependentInstallMatches,
      correctness:
        "all accepted file bytes, symlink targets, types and deletions match; ignored host file excluded",
      retainedMemory: globalThis.gc ? await collectRetainedMemory() : null,
      retainedMemoryAccounting: globalThis.gc
        ? "forced GC after all timing and correctness checks; workers then main"
        : "not measured; run with --expose-gc",

      physicalReaderAccounting:
        process.platform === "linux"
          ? "kernel storage reads"
          : "unavailable on this platform; snapshot bytes are compressed logical transfer bytes",
      agentDatabaseBytes: fs.statSync(agent.openOpenClawAgentDatabase({ agentId: "main" }).path)
        .size,
    };
    fs.writeFileSync(path.join(output, values.report), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({ report: path.join(output, values.report), fingerprint: result.fingerprint }),
    );
    break measurement;
  }
  await runOne(0);
  if (fileReads) {
    await delay(5_000);
    await runOne(0);
    // Drain the warmup pause interval before opening the measured heartbeat window.
    await nextGuestHeartbeat();
  }
  if (nativeTurns) {
    await nextGuestHeartbeat();
  }
  if (gatewayMode) {
    const rpcDiagnostics = channel("openclaw.gateway.rpc");
    const observeHandler = (message: unknown) => {
      // This native channel publishes the Gateway diagnostic owner's event contract.
      const event = message as Extract<DiagnosticEventInput, { type: "gateway.rpc" }>;
      if (
        event.phase === "handler" &&
        event.method === (fileReads ? "sessions.files.get" : "sessions.files.list")
      ) {
        handlerDurations.push(event.durationMs);
      }
    };
    rpcDiagnostics.subscribe(observeHandler);
    stopRpcDiagnostics = () => {
      rpcDiagnostics.unsubscribe(observeHandler);
    };
  }
  const initial = fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8");
  assert.equal(initial, "synthetic 0\n".padEnd(fileBytes, "."));
  acquisitions = 0;
  scans = 0;
  probes = 0;
  custodyDurationsMs.length = 0;
  containerCommands.length = 0;
  finalizations.length = 0;
  pauseDurationsMs.length = 0;
  checkpointPhases.length = 0;
  leaseSources.clear();
  const { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
    await import("../../src/infra/diagnostic-events.js");
  await waitForDiagnosticEventsDrained();
  const leaseRequests: Record<string, number> = {};
  stopLeaseDiagnostics = onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "worker.request" &&
        event.phase === "completed" &&
        event.requestClass.startsWith("stateLease.")
      ) {
        leaseRequests[event.requestClass] = (leaseRequests[event.requestClass] ?? 0) + 1;
      }
    },
    { include: ["worker.request"] },
  );
  globalThis.gc?.();
  const inspector = values.instrument === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await inspector?.post("Profiler.enable");
  await inspector?.post("Profiler.start");
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let gcMs = 0;
  const gcByKind: Record<string, { count: number; ms: number; maxMs: number }> = {};
  const observer = new PerformanceObserver((events) => {
    for (const entry of events.getEntries()) {
      gcMs += entry.duration;
      if (
        "detail" in entry &&
        typeof entry.detail === "object" &&
        entry.detail !== null &&
        "kind" in entry.detail
      ) {
        const summary = (gcByKind[String(entry.detail.kind)] ??= { count: 0, ms: 0, maxMs: 0 });
        summary.count++;
        summary.ms += entry.duration;
        summary.maxMs = Math.max(summary.maxMs, entry.duration);
      }
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const hostLoad = loadavg(),
    before = process.threadCpuUsage(),
    processBefore = process.cpuUsage(),
    start = performance.now();
  const spans: Record<string, { count: number; totalMs: number }> = {};
  const latencies: number[] = [];
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  let resultHash: string | undefined;
  let semanticResultHash: string | undefined;
  let representativeResult: unknown;
  for (let offset = 0; offset < requests; offset += burst) {
    if (fileReads) {
      await delay(Math.max(0, start + offset * readIntervalMs - performance.now()));
    }
    await Promise.all(
      Array.from({ length: Math.min(burst, requests - offset) }, async (_, i) => {
        const begin = performance.now(),
          result = await withDiagnosticsTimelineObserver(
            (name, _attributes, durationMs) => {
              const started = performance.now();
              return () => {
                const span = (spans[name] ??= { count: 0, totalMs: 0 });
                span.count++;
                span.totalMs += durationMs ?? performance.now() - started;
              };
            },
            () => runOne(offset + i),
          );
        latencies.push(performance.now() - begin);
        if (fileReads) {
          assert.equal(
            (result as { file?: { content?: string } }).file?.content,
            `synthetic ${(offset + i) % files}\n`.padEnd(fileBytes, "."),
            "Every Control UI read must return the selected file bytes",
          );
        }
        if (gatewayMode && !fileReads) {
          representativeResult ??= result;
          const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
          resultHash ??= hash;
          assert.equal(hash, resultHash, "Concurrent readers must return identical lists");
          semanticResultHash ??= createHash("sha256")
            .update(
              JSON.stringify(result, (_key, value: unknown) =>
                typeof value === "string" ? value.replaceAll(output, "<fixture>") : value,
              ),
            )
            .digest("hex");
        }
      }),
    );
  }
  if (fileReads || nativeTurns) {
    // Include the last operation's resumed heartbeat, not just intervals arriving mid-request.
    await nextGuestHeartbeat();
  }
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  const measuredTicks = guestTicks.filter((tick) => tick.at >= start);
  const elapsedMs = performance.now() - start,
    cpu = process.threadCpuUsage(before),
    processCpu = process.cpuUsage(processBefore);
  await waitForDiagnosticEventsDrained();
  stopLeaseDiagnostics();
  stopRpcDiagnostics();
  if (gatewayMode) {
    assert.equal(handlerDurations.length, requests, "Every measured RPC needs a handler sample");
  }
  const cpuProfile = await inspector?.post("Profiler.stop");
  const profile = await inspector?.post("HeapProfiler.stopSampling");
  if (cpuProfile) {
    fs.writeFileSync(
      path.join(output, `${values.report}.cpuprofile`),
      JSON.stringify(cpuProfile.profile),
    );
  }
  inspector?.disconnect();
  loop.disable();
  observer.disconnect();
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
  const sampledBytes = profile ? allocated(profile.profile.head) : undefined;
  latencies.sort((a, b) => a - b);
  handlerDurations.sort((a, b) => a - b);
  const distribution = (samples: number[]) => {
    const ordered = samples.toSorted((a, b) => a - b);
    const percentile = (p: number) => ordered[Math.floor((ordered.length - 1) * p)] ?? null;
    return {
      count: ordered.length,
      median: percentile(0.5),
      p95: percentile(0.95),
      max: ordered.at(-1) ?? null,
    };
  };
  const report = {
    mode: values.mode,
    harnessSha256,
    turn: turnLoop
      ? {
          tools: 10,
          changed: values["all-mutating"] ? 10 : 2,
          unchanged: values["all-mutating"] ? 0 : 8,
          pauses: containerCommands.filter((command) => command === "pause").length,
          unpauses: containerCommands.filter((command) => command === "unpause").length,
          filesystemType: fs.statfsSync(output).type,
          engine: nativeTurns ? "native Podman" : "synthetic execContainer seam; no injected delay",
          pauseDurationsMs: [...pauseDurationsMs],
          checkpointPhases: [...checkpointPhases],
          phaseAccounting:
            "withStagedWorkerWorkspaceManifest includes applyStagedWorkerWorkspace; phases overlap and must not be summed",
          percentileDefinition: "sorted sample at floor((count - 1) * percentile)",
          pauseDistributionMs: distribution(pauseDurationsMs),
          commandDistributionMs: distribution(
            finalizations.map((sample) => sample.commandDurationMs),
          ),
          finalizationDistributionMs: distribution(
            finalizations.map((sample) => sample.durationMs),
          ),
          pauseAccounting:
            "successful pause invocation through successful unpause return; upper bound on frozen interval",
          correctness: nativeTurns
            ? "canonical read and next guest read match after every mutating command finalization"
            : "canonical read matches after every mutating command finalization",
          commandAccounting:
            "command execution plus awaited finalization; subsequent correctness read excluded; CPU and allocation exclude child processes",
          finalizations,
        }
      : undefined,
    guest:
      fileReads || nativeTurns
        ? {
            image: values["guest-image"],
            readIntervalMs: fileReads ? readIntervalMs : undefined,
            filesystemType: fs.statfsSync(output).type,
            heartbeatIntervalMs: 20,
            ticks: measuredTicks.length,
            maxGapMs: Math.max(0, ...measuredTicks.map((tick) => tick.gapMs)),
            stallMs: measuredTicks.reduce((sum, tick) => sum + Math.max(0, tick.gapMs - 40), 0),
            pauses: containerCommands.filter((command) => command === "pause").length,
            unpauses: containerCommands.filter((command) => command === "unpause").length,
            commands: Object.fromEntries(
              [...new Set(containerCommands)].map((command) => [
                command,
                containerCommands.filter((value) => value === command).length,
              ]),
            ),
          }
        : undefined,
    allocatedBytesPerRequest: allocatedBytes / requests,
    allocationAccounting:
      "main-isolate V8 total allocated bytes, including background work; excludes workers",
    reusedFixture: reuseFixture,
    revision: values.revision ?? "candidate",
    instrument: values.instrument,
    requests,
    burst,
    files,
    fileBytes,
    transcriptMiB,
    separateAgentStorage: Boolean(values["agent-storage-dir"]),
    agentDatabaseBytes:
      values.mode === "preparation" || fileReads || turnLoop
        ? fs.statSync(agent.openOpenClawAgentDatabase({ agentId: "main" }).path).size
        : undefined,
    sessionRows: gatewayMode || values.mode === "preparation" || turnLoop ? 10_001 : 0,
    worktrees: maintained.length,
    sources: Object.fromEntries(
      [...source].map(([file, code]) => [file, createHash("sha256").update(code).digest("hex")]),
    ),
    hostLoad,
    hostLoadAfter: loadavg(),
    acquisitions,
    scans,
    probes,
    custodyDurationsMs: [...custodyDurationsMs],
    spans,
    absentProjection: workspace === undefined,
    leaseRequests,
    leaseSources: [...leaseSources.values()].map(({ scope, stack, calls }) => ({
      scope,
      stack,
      calls,
    })),
    leaseRequestsPerSimulatedIdleMinute:
      (Object.values(leaseRequests).reduce((sum, count) => sum + count, 0) * 16) / requests,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    mainThreadCpuPercent: (cpu.user + cpu.system) / (elapsedMs * 10),
    cpuUsPerRequest: (cpu.user + cpu.system) / requests,
    sampledBytesPerRequest: sampledBytes === undefined ? null : sampledBytes / requests,
    sampledBytesPerSecond: sampledBytes === undefined ? null : (sampledBytes * 1000) / elapsedMs,
    eventLoopP99Ms: loop.percentile(99) / 1e6,
    eventLoopSamples: loop.count,
    requestLatenciesMs: latencies,
    requestP50Ms: latencies[Math.floor((latencies.length - 1) * 0.5)],
    requestP95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
    requestP99Ms: latencies[Math.floor((latencies.length - 1) * 0.99)],
    ...(gatewayMode
      ? {
          serverHandlerSamples: handlerDurations.length,
          serverHandlerP99Ms: handlerDurations[Math.floor((handlerDurations.length - 1) * 0.99)],
        }
      : {}),
    gcMs,
    gcByKind,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    memory: process.memoryUsage(),
    resultHash,
    semanticResultHash,
  };
  if (representativeResult !== undefined) {
    fs.writeFileSync(
      path.join(output, "response.json"),
      JSON.stringify(representativeResult, null, 2),
    );
  }
  for (const record of maintained) {
    assert(
      fs.statSync(record.path).isDirectory(),
      "Maintenance must preserve registered checkouts",
    );
  }
  if (workspace) {
    fs.writeFileSync(path.join(workspace, "file-0.txt"), "fresh later guest write\n");
    const refreshed = turnLoop ? await projection.checkpointLocalWorkspace(owner) : await runOne(0);
    if (fileReads) {
      assert.equal(
        (refreshed as { file?: { content?: string } }).file?.content,
        "fresh later guest write\n",
      );
      // Freshness proof must not change the next arm's input. Reconcile the restored
      // sentinel outside measurement, including when the read itself did not publish it.
      fs.writeFileSync(path.join(workspace, "file-0.txt"), initial);
      await projection.checkpointLocalWorkspace(owner);
      assert.equal(fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8"), initial);
    } else {
      assert.equal(
        fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8"),
        "fresh later guest write\n",
      );
    }
  } else {
    assert.equal(fs.readFileSync(path.join(canonical, "file-0.txt"), "utf8"), initial);
  }
  if (turnLoop) {
    fs.writeFileSync(path.join(workspace!, "file-0.txt"), initial);
    for (const editedFile of [Math.floor(files / 3), Math.floor((2 * files) / 3)]) {
      fs.writeFileSync(
        path.join(workspace!, `file-${editedFile}.txt`),
        `synthetic ${editedFile}\n`.padEnd(fileBytes, "."),
      );
    }
    await projection.checkpointLocalWorkspace(owner);
  }
  let retainedMemory;
  if (values.instrument === "retention") {
    const remainingMs = start + retentionMs - performance.now();
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }
    retainedMemory = {
      ...(await collectRetainedMemory()),
      elapsedMs: performance.now() - start,
      minimumElapsedMs: retentionMs,
    };
  }
  const verified = {
    ...report,
    retainedMemory,
    freshness: workspace ? "passed" : "absent projection unchanged",
  };
  fs.writeFileSync(path.join(output, values.report), JSON.stringify(verified, null, 2));
  console.log(JSON.stringify(verified));
} finally {
  turnProjection?.[Symbol.dispose]();
  if (turnLoop && !nativeTurns) {
    await (
      await import("../../src/agents/sandbox/registry.js")
    ).removeRegistryEntry("synthetic-turn");
  }
  if (guestName) {
    // Only the named task fixture is stopped, including if an interrupted read left it paused.
    const engine = nativeTurns ? "podman" : "docker";
    spawnSync(engine, ["unpause", guestName], { stdio: "ignore" });
    execFileSync(engine, ["rm", "--force", guestName], { stdio: "ignore" });
    await guestExited;
    await (await import("../../src/agents/sandbox/registry.js")).removeRegistryEntry(guestName);
  }
  stopRpcDiagnostics();
  stopLeaseDiagnostics();
  for (const client of clients) {
    client.stop();
  }
  endHeartbeat.resolve();
  await heartbeatDone;
  process.off("worker", observeWorker);
  await server?.close({ reason: "synthetic checkpoint measurement complete" });
  if (sandboxRegistryClose) {
    const before = performance.now();
    const cpuBefore = process.cpuUsage();
    const allocatedBefore = getHeapStatistics().total_allocated_bytes;
    await sandboxRegistryClose.drain();
    const cpu = process.cpuUsage(cpuBefore);
    const cleanup = {
      drainMs: performance.now() - before,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes: getHeapStatistics().total_allocated_bytes - allocatedBefore,
      engine: fakeBuilderEngine!.snapshot(),
    };
    fs.writeFileSync(path.join(output, "builder-cleanup.json"), JSON.stringify(cleanup, null, 2));
    console.log(JSON.stringify({ builderCleanup: cleanup }));
    assert.equal(cleanup.engine.remaining.length, 0, "Builder survived registry shutdown drain");
  }
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
  await (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState();
}
