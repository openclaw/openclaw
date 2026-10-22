// Synthetic owner-boundary benchmark; each source runs in an isolated Node process.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { createWriteStream, writeSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { WorkerWorkspaceManifestEntry } from "../src/gateway/worker-environments/workspace-manifest.js";
import {
  emitBenchmarkReport,
  parseBenchmarkInteger,
  parseBenchmarkIntegerList,
  parseBenchmarkOptions,
  runBenchmarkEntrypoint,
} from "./lib/benchmark-harness.mts";
import { startBenchmarkIntervalDelay } from "./lib/benchmark-interval-delay.ts";
import { createBuildSmokeEnv } from "./lib/build-smoke-env.mts";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { startGatewayBenchDiagnostics } from "./lib/gateway-bench-diagnostics.ts";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "./lib/gateway-bench-profile.ts";

const exec = promisify(execFile);
const diagnostics = channel("openclaw.worker.task");
const gitDiagnostics = channel("openclaw.git.operation");
const scenarios = [
  "inventory",
  "manifest",
  "delta",
  "unchanged",
  "compare",
  "reconcile",
  "checkpoint",
] as const;
type Scenario = (typeof scenarios)[number];
type Options = {
  baseline?: string;
  candidate: string;
  sourceCommit?: string;
  scenarios: Scenario[];
  sizes: number[];
  concurrency: number[];
  runs: number;
  warmup: number;
  fileBytes: number;
  changedFiles: number;
  timeoutMs: number;
  startAt?: number;
  startBarrier?: string;
  samplingInterval: number;
  prepareRoot?: string;
  reuseRoot?: string;
  output?: string;
  json: boolean;
  help: boolean;
};
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Measurement = {
  wallMs: number;
  cpuMs: number;
  entriesPerSecond: number;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelaySamples: number;
  intervalDelayMs: Summary;
  eventLoopUtilization: number;
  memoryBefore: NodeJS.MemoryUsage;
  memoryAfter: NodeJS.MemoryUsage;
  processMaxRssBytes: number;
  workerTasks: Array<Record<string, unknown>>;
  operations: Record<string, number>;
  allocation?: ReturnType<typeof summarizeAllocation>;
  diagnostics: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>>;
};
type Summary = ReturnType<typeof summarize>;
type Sample = Measurement & {
  phase: "cold" | "warmup" | "warm";
  requestLatencyMs: Summary;
  externalPeakRssBytes: number | null;
  requestFailures: number;
  evidence: string[];
  gcTrace?: ReturnType<typeof readGatewayGcTrace>;
};
type ChildMessage =
  | { type: "ready"; port: number; moduleLoadMs: number }
  | { type: "measured"; value: Measurement }
  | { type: "verified"; evidence: string[] }
  | { type: "error"; message: string };

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const nameAt = (index: number) => `file-${String(index).padStart(6, "0")}.txt`;

function summarize(values: number[]) {
  assert(values.length > 0, "measurement has no samples");
  const ordered = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => ordered[Math.ceil(ordered.length * fraction) - 1]!;
  return {
    count: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1)!,
  };
}

function parseOptions(argv: string[]): Options {
  return parseBenchmarkOptions<Options>(
    argv,
    {
      candidate: process.cwd(),
      scenarios: [...scenarios],
      sizes: [1_000],
      concurrency: [1],
      runs: 3,
      warmup: 1,
      fileBytes: 1_024,
      changedFiles: 1,
      timeoutMs: 300_000,
      samplingInterval: 0,
      json: false,
      help: false,
    },
    {
      "--baseline": (options, value) => {
        options.baseline = path.resolve(value);
      },
      "--candidate": (options, value) => {
        options.candidate = path.resolve(value);
      },
      "--source-commit": (options, value) => {
        assert(/^[a-f0-9]{40}$/u.test(value), "--source-commit requires a full commit SHA");
        options.sourceCommit = value;
      },
      "--scenarios": (options, value) => {
        const names = value.split(",");
        assert(
          names.length && names.every((name) => scenarios.includes(name as Scenario)),
          "invalid --scenarios",
        );
        assert.equal(new Set(names).size, names.length, "duplicate --scenarios");
        options.scenarios = names as Scenario[];
      },
      "--sizes": (options, value) => {
        options.sizes = parseBenchmarkIntegerList(value, "--sizes", 100_000);
      },
      "--concurrency": (options, value) => {
        options.concurrency = parseBenchmarkIntegerList(value, "--concurrency", 4);
      },
      "--runs": (options, value) => {
        options.runs = parseBenchmarkInteger(value, "--runs", 1, 1_000);
      },
      "--warmup": (options, value) => {
        options.warmup = parseBenchmarkInteger(value, "--warmup", 0, 10);
      },
      "--file-bytes": (options, value) => {
        options.fileBytes = parseBenchmarkInteger(value, "--file-bytes", 1, 64 * 1024 * 1024);
      },
      "--changed-files": (options, value) => {
        options.changedFiles = parseBenchmarkInteger(value, "--changed-files", 0, 5_000);
      },
      "--timeout-ms": (options, value) => {
        options.timeoutMs = parseBenchmarkInteger(value, "--timeout-ms", 1_000, 3_600_000);
      },
      "--start-at": (options, value) => {
        options.startAt = parseBenchmarkInteger(value, "--start-at", 1, Number.MAX_SAFE_INTEGER);
      },
      "--start-barrier": (options, value) => {
        options.startBarrier = path.resolve(value);
      },
      "--sampling-interval": (options, value) => {
        options.samplingInterval = parseBenchmarkInteger(
          value,
          "--sampling-interval",
          0,
          1_048_576,
        );
      },
      "--prepare-root": (options, value) => {
        options.prepareRoot = path.resolve(value);
      },
      "--reuse-root": (options, value) => {
        options.reuseRoot = path.resolve(value);
      },
      "--output": (options, value) => {
        options.output = path.resolve(value);
      },
    },
  );
}

async function createFixture(params: {
  root: string;
  source: string;
  scenario: Scenario;
  size: number;
  concurrency: number;
  options: Options;
}) {
  const { root, source, scenario, size, concurrency, options } = params;
  const reconciliation = scenario === "reconcile";
  const checkpoint = scenario === "checkpoint";
  assert(
    size * options.fileBytes <= 4 * 1024 ** 3,
    "fixture exceeds the production 4 GiB inventory limit",
  );
  await fs.mkdir(root, { recursive: true });
  const content = Buffer.alloc(options.fileBytes, 65);
  const changed = Buffer.from("worker change\n");
  const sha256 = digest(content);
  const entries = Array.from({ length: size }, (_, index): WorkerWorkspaceManifestEntry => ({
    path: nameAt(index),
    type: "file",
    mode: 0o644,
    size: content.length,
    sha256,
  }));
  const changedFiles =
    scenario === "delta" || scenario === "compare" || reconciliation || checkpoint
      ? options.changedFiles
      : 0;
  assert(changedFiles <= size, "--changed-files exceeds the fixture entry count");
  const changedEntries = Array.from(
    { length: changedFiles },
    (_, index): WorkerWorkspaceManifestEntry => ({
      path: nameAt(index),
      type: "file",
      mode: 0o644,
      size: changed.length,
      sha256: digest(changed),
    }),
  );
  const baseRaw = JSON.stringify({ version: 1, baseCommit: null, entries });
  const currentRaw =
    changedFiles > 0
      ? JSON.stringify({
          version: 1,
          baseCommit: null,
          entries: [...changedEntries, ...entries.slice(changedFiles)],
        })
      : baseRaw;
  await Promise.all([
    fs.writeFile(path.join(root, "base.json"), baseRaw),
    fs.writeFile(path.join(root, "current.json"), currentRaw),
    fs.mkdir(path.join(root, "home")),
    fs.writeFile(path.join(root, "config.json"), "{}\n"),
  ]);
  for (let lane = 0; lane < concurrency; lane++) {
    const workspace = path.join(root, `workspace-${lane}`);
    await fs.mkdir(workspace);
    if (
      scenario === "inventory" ||
      scenario === "delta" ||
      scenario === "unchanged" ||
      reconciliation ||
      checkpoint
    ) {
      await exec("git", ["-c", `core.hooksPath=${os.devNull}`, "init", "--quiet", workspace], {
        env: isolatedEnv(root),
      });
    }
    if (reconciliation || checkpoint) {
      assert(size * options.fileBytes <= 128 * 1024 ** 2, "reconciliation fixture exceeds 128 MiB");
      for (let index = 0; index < size; index++) {
        await fs.writeFile(path.join(workspace, nameAt(index)), content, { mode: 0o644 });
        if (index % 256 === 0) {
          await checkDirtyPages();
        }
      }
    } else if (scenario === "inventory" || scenario === "manifest") {
      let next = 0;
      await Promise.all(
        Array.from({ length: 32 }, async () => {
          while (next < size) {
            await fs.writeFile(path.join(workspace, nameAt(next++)), content, { mode: 0o644 });
          }
        }),
      );
    }
    if (checkpoint) {
      const git = (...args: string[]) =>
        exec("git", ["-C", workspace, ...args], {
          env: isolatedEnv(root),
        });
      await git("symbolic-ref", "HEAD", "refs/heads/main");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Synthetic fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Synthetic baseline",
      );
    }
    if (scenario === "delta" || scenario === "unchanged" || reconciliation) {
      const payload = path.join(root, `payload-${lane}`);
      await fs.mkdir(payload);
      for (const entry of changedEntries) {
        await fs.writeFile(path.join(payload, entry.path), changed, { mode: 0o644 });
      }
    }
  }
  return {
    root,
    source,
    scenario,
    size,
    concurrency,
    timeoutMs: options.timeoutMs,
    baseRef: `sha256:${digest(baseRaw)}`,
    currentRef: `sha256:${digest(currentRaw)}`,
    changedEntries,
    fileBytes: options.fileBytes,
    samplingInterval: options.samplingInterval,
    startAt: options.startAt,
    startBarrier: options.startBarrier,
    startSample: options.warmup + 1,
    inventorySha256: digest(entries.map((entry) => `${entry.path}\0`).join("")),
  };
}

async function checkDirtyPages() {
  if (process.platform === "linux") {
    const memory = await fs.readFile("/proc/meminfo", "utf8");
    const dirtyKiB = Number(/^Dirty:\s+(\d+)\s+kB$/m.exec(memory)?.[1]);
    assert(
      Number.isFinite(dirtyKiB) && dirtyKiB < 2 * 1024 ** 2,
      "host dirty pages reached 2 GiB; stop fixture writes",
    );
  }
}

function summarizeAllocation(profile: HeapProfiler.SamplingHeapProfile) {
  let totalBytes = 0;
  let workspaceBytes = 0;
  const sites: Array<{ functionName: string; url: string; bytes: number }> = [];
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, underWorkspace: boolean) => {
    const owned =
      underWorkspace ||
      /\/(?:workspace-(?:manifest|reconcile|actual|hash)|local-workspace-|owned-directory-observation)/u.test(
        node.callFrame.url,
      );
    totalBytes += node.selfSize;
    if (owned) {
      workspaceBytes += node.selfSize;
    }
    if (node.selfSize > 0) {
      sites.push({
        functionName: node.callFrame.functionName,
        url: node.callFrame.url,
        bytes: node.selfSize,
      });
    }
    for (const child of node.children) {
      visit(child, owned);
    }
  };
  visit(profile.head, false);
  return {
    totalBytes,
    workspaceBytes,
    topSites: sites.toSorted((a, b) => b.bytes - a.bytes).slice(0, 40),
  };
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...createBuildSmokeEnv(path.join(root, "home"), {}),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
    NODE_ENV: "test",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
}

async function importOwner<T>(root: string, relative: string): Promise<T> {
  return (await import(pathToFileURL(path.join(root, relative)).href)) as T;
}

async function childMain(fixturePath: string): Promise<void> {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as Fixture;
  // Checkpoint GC runs must also work without allocation sampling, whose
  // start/stop cycle forces collections between measured operations.
  const traceGc = fixture.scenario === "checkpoint" || fixture.samplingInterval > 0;
  const inspector = traceGc ? new Session() : undefined;
  inspector?.connect();
  const markGc = (phase: string, profilePath?: string) => {
    if (inspector) {
      writeSync(
        1,
        `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
      );
    }
  };
  if (inspector) {
    markGc("identify-start");
    await inspector.post("HeapProfiler.collectGarbage");
    markGc("identify-stop");
  }
  const reconciliation = fixture.scenario === "reconcile";
  const loadedAt = performance.now();
  const inventory =
    fixture.scenario === "inventory"
      ? await importOwner<
          typeof import("../src/gateway/worker-environments/workspace-sync-inventory.js")
        >(fixture.source, "src/gateway/worker-environments/workspace-sync-inventory.ts")
      : undefined;
  const manifests =
    fixture.scenario === "manifest"
      ? await importOwner<
          typeof import("../src/gateway/worker-environments/workspace-manifest-worker.js")
        >(fixture.source, "src/gateway/worker-environments/workspace-manifest-worker.ts")
      : undefined;
  const staging =
    fixture.scenario === "delta" ||
    fixture.scenario === "unchanged" ||
    fixture.scenario === "compare"
      ? await importOwner<
          typeof import("../src/gateway/worker-environments/workspace-result-staging.js")
        >(fixture.source, "src/gateway/worker-environments/workspace-result-staging.ts")
      : undefined;
  const git = staging
    ? await importOwner<typeof import("../src/infra/git-worker.js")>(
        fixture.source,
        "src/infra/git-worker.ts",
      )
    : undefined;
  const lifecycle = await importOwner<typeof import("../src/shared/global-singleton.js")>(
    fixture.source,
    "src/shared/global-singleton.ts",
  );
  const reconcile = reconciliation
    ? await importOwner<typeof import("../src/gateway/worker-environments/workspace-reconcile.js")>(
        fixture.source,
        "src/gateway/worker-environments/workspace-reconcile.ts",
      )
    : undefined;
  const baseRaw =
    staging || reconciliation
      ? await fs.readFile(path.join(fixture.root, "base.json"), "utf8")
      : "";
  const currentRaw =
    staging || reconciliation
      ? await fs.readFile(path.join(fixture.root, "current.json"), "utf8")
      : "";
  const parser =
    fixture.scenario === "compare" || reconciliation
      ? await importOwner<
          typeof import("../src/gateway/worker-environments/workspace-manifest.js")
        >(fixture.source, "src/gateway/worker-environments/workspace-manifest.ts")
      : undefined;
  // Uploads already retain raw manifests and decoded facts. Keep their parsing
  // outside the measured comparison, with independent facts for each caller.
  const comparisons = parser
    ? Array.from({ length: fixture.concurrency }, () => ({
        base: parser.parseWorkerWorkspaceManifest(baseRaw, fixture.baseRef),
        current: parser.parseWorkerWorkspaceManifest(currentRaw, fixture.currentRef),
      }))
    : undefined;
  const checkpointOwner =
    fixture.scenario === "checkpoint"
      ? await importOwner<
          typeof import("../src/gateway/worker-environments/local-workspace-projection.js")
        >(fixture.source, "src/gateway/worker-environments/local-workspace-projection.ts")
      : undefined;
  const checkpointStore = checkpointOwner
    ? await importOwner<
        typeof import("../src/gateway/worker-environments/local-workspace-store.js")
      >(fixture.source, "src/gateway/worker-environments/local-workspace-store.ts")
    : undefined;
  const checkpoints: Array<{
    id: string;
    workspace: string;
    projection: NonNullable<
      Awaited<
        ReturnType<
          typeof import("../src/agents/sandbox/local-workspace.js").prepareLocalSandboxWorkspace
        >
      >
    >;
  }> = [];
  if (checkpointOwner) {
    const [registry, sessions, paths, sandbox, config] = await Promise.all([
      importOwner<typeof import("../src/agents/worktrees/registry.js")>(
        fixture.source,
        "src/agents/worktrees/registry.ts",
      ),
      importOwner<typeof import("../src/config/sessions/session-accessor.js")>(
        fixture.source,
        "src/config/sessions/session-accessor.ts",
      ),
      importOwner<typeof import("../src/config/sessions/paths.js")>(
        fixture.source,
        "src/config/sessions/paths.ts",
      ),
      importOwner<typeof import("../src/agents/sandbox/local-workspace.js")>(
        fixture.source,
        "src/agents/sandbox/local-workspace.ts",
      ),
      importOwner<typeof import("../src/agents/sandbox/config.js")>(
        fixture.source,
        "src/agents/sandbox/config.ts",
      ),
    ]);
    const { setRuntimeConfigSnapshot } = await importOwner<
      typeof import("../src/config/runtime-snapshot.js")
    >(fixture.source, "src/config/runtime-snapshot.ts");
    setRuntimeConfigSnapshot({});
    for (let lane = 0; lane < fixture.concurrency; lane++) {
      const root = path.join(fixture.root, `workspace-${lane}`);
      const sessionKey = `agent:main:benchmark:${lane}`;
      const owner: import("../src/gateway/worker-environments/local-workspace-types.js").LocalWorkspaceOwner =
        {
          agentId: "main",
          sessionKey,
          sessionId: `benchmark-${lane}`,
          lifecycleRevision: null,
          assertCurrent() {},
          worktree: {
            id: `00000000-0000-4000-8000-${String(lane).padStart(12, "0")}`,
            name: "benchmark",
            repoFingerprint: "synthetic",
            repoRoot: root,
            path: root,
            branch: "main",
            baseRef: "HEAD",
            ownerKind: "session",
            ownerId: sessionKey,
            createdAt: 0,
            lastActiveAt: 0,
          },
        };
      await registry.insertRegistryWorktree(process.env, owner.worktree);
      await sessions.replaceSessionEntry(
        {
          agentId: owner.agentId,
          sessionKey,
          storePath: paths.resolveSessionStorePathCore(undefined, { agentId: owner.agentId }),
        },
        {
          sessionId: owner.sessionId,
          updatedAt: 1,
          worktree: { id: owner.worktree.id, repoRoot: root, branch: "main" },
        },
      );
      const cfg = { worktreeAcceleration: false };
      const projection = await sandbox.prepareLocalSandboxWorkspace({
        cfg,
        agentId: owner.agentId,
        sessionKey,
        workspaceDir: root,
        sandbox: config.resolveSandboxConfigForAgent(cfg, owner.agentId),
      });
      assert(projection, "managed checkpoint workspace was not prepared");
      checkpoints.push({ id: owner.worktree.id, projection, workspace: projection.workspaceDir });
    }
  }
  const moduleLoadMs = performance.now() - loadedAt;
  const server = createServer((_request, response) => response.writeHead(200).end("ready\n"));
  let address;
  for (let attempt = 0; attempt < 32; attempt++) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    address = server.address();
    assert(address && typeof address !== "string");
    if (address.port >= 40_000) {
      break;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  assert(
    address && typeof address !== "string" && address.port >= 40_000,
    "no ephemeral loopback port >= 40000 available",
  );
  process.send?.({ type: "ready", port: address.port, moduleLoadMs });
  let sequence = 0;
  const taskEvents: Array<Record<string, unknown>> = [];
  let operations: Record<string, number> = {};
  const observeOperation = (event: unknown) => {
    if (
      event &&
      typeof event === "object" &&
      "operation" in event &&
      typeof event.operation === "string"
    ) {
      operations[event.operation] = (operations[event.operation] ?? 0) + 1;
    }
  };
  const observe = (event: unknown) => {
    taskEvents.push(event as Record<string, unknown>);
  };
  diagnostics.subscribe(observe);
  gitDiagnostics.subscribe(observeOperation);
  let stopIntervalDelay: (() => number[]) | undefined;
  try {
    while ((await nextCommand()) === "run") {
      const sample = sequence++;
      if (reconcile && fixture.scenario === "reconcile") {
        const content = Buffer.alloc(fixture.fileBytes, 65);
        for (let lane = 0; lane < fixture.concurrency; lane++) {
          for (const entry of fixture.changedEntries) {
            await fs.writeFile(path.join(fixture.root, `workspace-${lane}`, entry.path), content);
          }
        }
      }
      const checkpointContent = `checkpoint content ${sample}\n`;
      for (const checkpoint of checkpoints) {
        for (const entry of fixture.changedEntries) {
          await fs.writeFile(path.join(checkpoint.workspace, entry.path), checkpointContent);
        }
      }
      if (sample === fixture.startSample && fixture.startBarrier !== undefined) {
        await fs.writeFile(`${fixture.startBarrier}.ready`, "ready\n");
        const deadline = Date.now() + fixture.timeoutMs;
        while (
          !(await fs.access(`${fixture.startBarrier}.go`).then(
            () => true,
            () => false,
          ))
        ) {
          assert(Date.now() < deadline, "coordinated start barrier timed out");
          await delay(20);
        }
      }
      if (sample === fixture.startSample && fixture.startAt !== undefined) {
        assert(Date.now() < fixture.startAt, "missed coordinated start; choose a later --start-at");
        await delay(fixture.startAt - Date.now());
      }
      taskEvents.length = 0;
      operations = {};
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      await delay(20);
      histogram.reset();
      stopIntervalDelay = startBenchmarkIntervalDelay();
      const stopDiagnostics = startGatewayBenchDiagnostics();
      if (inspector && fixture.samplingInterval > 0) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: fixture.samplingInterval,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const memoryBefore = process.memoryUsage();
      const cpu = process.cpuUsage();
      const utilization = performance.eventLoopUtilization();
      markGc("heap-start", `workspace-sample-${sample}`);
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: fixture.concurrency }, async (_, lane) => {
          const root = path.join(fixture.root, `workspace-${lane}`);
          if (inventory) {
            const output = await inventory.createWorkspaceGitTransferList({
              gitRoot: root,
              temporaryDirectory: path.join(fixture.root, `inventory-${sample}-${lane}`),
              timeoutMs: fixture.timeoutMs,
              signal: AbortSignal.timeout(fixture.timeoutMs),
            });
            return async () => {
              const bytes = await fs.readFile(output);
              assert.equal(digest(bytes), fixture.inventorySha256);
              return digest(bytes);
            };
          }
          if (manifests) {
            const result = await manifests.captureWorkspaceManifest({
              root,
              baseCommit: null,
              signal: AbortSignal.timeout(fixture.timeoutMs),
            });
            return async () => {
              assert.equal(result.manifestRef, fixture.baseRef);
              assert.equal(result.manifest.entries.length, fixture.size);
              assert.equal(
                `sha256:${digest(
                  JSON.stringify({
                    version: result.manifest.version,
                    baseCommit: result.manifest.baseCommit,
                    entries: result.manifest.entries,
                  }),
                )}`,
                fixture.baseRef,
              );
              return result.manifestRef;
            };
          }
          if (checkpointOwner && checkpointStore) {
            const { id, projection } = checkpoints[lane]!;
            await projection.checkpoint();
            return async () => {
              const row = await checkpointStore.withLocalWorkspaceStore(
                { worktreeId: id },
                async (store) => store.get(),
              );
              assert(row?.baseline_ref, "checkpoint did not publish its baseline");
              assert.equal(row.pending_ref, null);
              assert.equal(row.pending_target, null);
              assert.equal(row.journal_json, null);
              for (const entry of fixture.changedEntries) {
                assert.equal(
                  await fs.readFile(path.join(root, entry.path), "utf8"),
                  checkpointContent,
                );
              }
              if (fixture.changedEntries.length < fixture.size) {
                assert.deepEqual(
                  await fs.readFile(path.join(root, nameAt(fixture.size - 1))),
                  Buffer.alloc(fixture.fileBytes, 65),
                );
              }
              return `checkpoint:${fixture.changedEntries.length}`;
            };
          }
          if (reconcile) {
            const { current, base } = comparisons![lane]!;
            let committedRef: string | undefined;
            let began = false;
            const result = await reconcile.applyStagedWorkerWorkspace({
              root,
              stagingRoot: path.join(fixture.root, `payload-${lane}`),
              baseManifestRef: fixture.baseRef,
              currentManifestRef: fixture.currentRef,
              base,
              current,
              acceptance: { kind: "reconcile" },
              journal: {
                load: async () => undefined,
                begin: async () => {
                  began = true;
                },
                commit: async (ref) => {
                  committedRef = ref;
                },
                abort: async () => {
                  throw new Error("unexpected reconciliation rollback");
                },
              },
            });
            return async () => {
              assert.equal(began, fixture.changedEntries.length > 0);
              assert.equal(committedRef, fixture.currentRef);
              assert.equal(result.manifestRef, fixture.currentRef);
              assert.deepEqual(result.conflictPaths, []);
              assert.deepEqual(result.manifest.entries, current.entries);
              for (const entry of fixture.changedEntries) {
                assert.equal(
                  await fs.readFile(path.join(root, entry.path), "utf8"),
                  "worker change\n",
                );
              }
              return result.manifestRef;
            };
          }
          assert(staging && git);
          if (comparisons) {
            const { current, base } = comparisons[lane]!;
            const paths = staging.workerWorkspaceTransferPaths(current, base);
            return async () => {
              assert.deepEqual(
                paths,
                fixture.changedEntries.map((entry) => entry.path),
              );
              return digest(JSON.stringify(paths));
            };
          }
          const ref = staging.workerWorkspaceResultRef(`benchmark-${sample}`);
          await staging.workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
            root,
            stagingRoot: path.join(fixture.root, `payload-${lane}`),
            stagedResultRef: ref,
            baseManifestRaw: baseRaw,
            currentManifestRaw: currentRaw,
            baseManifestRef: fixture.baseRef,
            currentManifestRef: fixture.currentRef,
          });
          const artifacts = await git.runGitWorkerOperation({
            type: "workspace.artifacts",
            input: { root, ref },
          });
          return async () => {
            assert.equal(artifacts.baseManifestRef, fixture.baseRef);
            assert.equal(artifacts.currentManifestRef, fixture.currentRef);
            assert.deepEqual(artifacts.changedEntries, fixture.changedEntries);
            return digest(JSON.stringify(artifacts));
          };
        }),
      );
      const wallMs = performance.now() - start;
      markGc("heap-stop", `workspace-sample-${sample}`);
      const usedCpu = process.cpuUsage(cpu);
      const eventLoopUtilization = performance.eventLoopUtilization(utilization).utilization;
      const memoryAfter = process.memoryUsage();
      const collectedDiagnostics = stopDiagnostics();
      const allocation =
        inspector && fixture.samplingInterval > 0
          ? summarizeAllocation((await inspector.post("HeapProfiler.stopSampling")).profile)
          : undefined;
      // Give the histogram's already-due sample a turn before reading it.
      await delay(15);
      histogram.disable();
      const intervalDelayMs = summarize(stopIntervalDelay());
      stopIntervalDelay = undefined;
      const value: Measurement = {
        wallMs,
        cpuMs: (usedCpu.user + usedCpu.system) / 1_000,
        entriesPerSecond: (fixture.size * fixture.concurrency * 1_000) / wallMs,
        eventLoopDelayMaxMs: histogram.max / 1e6,
        eventLoopDelayP99Ms: histogram.percentile(99) / 1e6,
        eventLoopDelaySamples: histogram.count,
        intervalDelayMs,
        eventLoopUtilization,
        memoryBefore,
        memoryAfter,
        processMaxRssBytes: process.resourceUsage().maxRSS * 1_024,
        workerTasks: [...taskEvents],
        operations: { ...operations },
        allocation,
        diagnostics: collectedDiagnostics,
      };
      process.send?.({ type: "measured", value });
      // Keep validation outside both the timed operation and the external probes.
      assert.equal(await nextCommand(), "verify");
      const evidence = await Promise.all(results.map((verify) => verify()));
      process.send?.({ type: "verified", evidence });
    }
  } finally {
    stopIntervalDelay?.();
    diagnostics.unsubscribe(observe);
    gitDiagnostics.unsubscribe(observeOperation);
    inspector?.disconnect();
    for (const { projection } of checkpoints) {
      projection[Symbol.dispose]();
    }
    await lifecycle.drainGlobalSingletonLifecycleState();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function nextCommand(): Promise<unknown> {
  const [message] = await once(process, "message");
  return message;
}

async function externalRss(pid: number): Promise<number | null> {
  // Keep platform sampling outside the measured process and off the HTTP probe loop.
  if (process.platform === "win32") {
    return null;
  }
  const result = await exec("ps", ["-o", "rss=", "-p", String(pid)]).catch(() => undefined);
  const rss = Number(result?.stdout.trim());
  return Number.isFinite(rss) && rss > 0 ? rss * 1_024 : null;
}

async function runSource(
  fixture: Fixture,
  options: Options,
): Promise<{ moduleLoadMs: number; samples: Sample[] }> {
  if (fixture.scenario === "checkpoint") {
    // Each child owns a fresh synthetic database/projection; source files persist
    // to avoid bulk fixture generation inside the measurement window.
    await fs.rm(path.join(fixture.root, "state"), { recursive: true, force: true });
  }
  const fixturePath = path.join(fixture.root, "fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
  const traceGc = fixture.scenario === "checkpoint" || fixture.samplingInterval > 0;
  const child = fork(fileURLToPath(import.meta.url), ["--worker", fixturePath], {
    cwd: fixture.source,
    execArgv: [
      ...(traceGc ? ["--trace-gc-nvp"] : []),
      "--import",
      path.join(fixture.source, "scripts/tsx.mjs"),
    ],
    env: isolatedEnv(fixture.root),
    detached: process.platform !== "win32",
    silent: true,
  });
  let output = "";
  const tracePath = path.join(fixture.root, "gc-trace.log");
  const trace = traceGc ? createWriteStream(tracePath) : undefined;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      trace?.write(chunk);
    });
  }
  const inbox: ChildMessage[] = [];
  let notify: (() => void) | undefined;
  let failure: Error | undefined;
  child.on("message", (message) => {
    inbox.push(message as ChildMessage);
    notify?.();
  });
  child.on("error", (error) => {
    failure = error;
    notify?.();
  });
  child.on("exit", (code, signal) => {
    failure = new Error(`benchmark child exited (${code ?? signal})\n${output}`);
    notify?.();
  });
  const receive = async () => {
    const message = await new Promise<ChildMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`benchmark child timed out\n${output}`)),
        options.timeoutMs,
      );
      notify = () => {
        const next = inbox.shift();
        if (next || failure) {
          clearTimeout(timer);
          notify = undefined;
          if (next) {
            resolve(next);
          } else if (failure) {
            reject(failure);
          }
        }
      };
      notify();
    });
    if (message.type === "error") {
      throw new Error(message.message);
    }
    return message;
  };
  const samples: Sample[] = [];
  try {
    const ready = await receive();
    assert.equal<"ready">(ready.type, "ready");
    const url = `http://127.0.0.1:${ready.port}/readyz`;
    const initial = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
    assert.equal(initial.status, 200);
    await initial.text();
    for (let sample = 0; sample < 1 + options.warmup + options.runs; sample++) {
      const sampling = new AbortController();
      const latencies: number[] = [];
      let requestFailures = 0;
      let peakRss: number | null = await externalRss(child.pid!);
      const probing = (async () => {
        while (!sampling.signal.aborted) {
          const start = performance.now();
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
            await response.text();
            if (response.status !== 200) {
              requestFailures++;
            }
          } catch {
            requestFailures++;
          }
          latencies.push(performance.now() - start);
          if (!sampling.signal.aborted) {
            await delay(10);
          }
        }
      })();
      const memory = (async () => {
        while (!sampling.signal.aborted) {
          const rss = await externalRss(child.pid!);
          if (rss !== null) {
            peakRss = Math.max(peakRss ?? 0, rss);
          }
          if (!sampling.signal.aborted) {
            await delay(50);
          }
        }
      })();
      let measured: ChildMessage;
      try {
        child.send("run");
        measured = await receive();
      } catch (error) {
        // Close a failed owner before joining probes that may still await its response.
        await stopChild(child);
        throw error;
      } finally {
        sampling.abort();
        await Promise.all([probing, memory]);
      }
      assert(measured.type === "measured", "child did not return measurement");
      child.send("verify");
      const verified = await receive();
      assert(verified.type === "verified", "child did not verify its result");
      assert.equal(requestFailures, 0, "HTTP responsiveness probe failed");
      samples.push({
        ...measured.value,
        phase: sample === 0 ? "cold" : sample <= options.warmup ? "warmup" : "warm",
        requestLatencyMs: summarize(latencies),
        requestFailures,
        externalPeakRssBytes: peakRss,
        evidence: verified.evidence,
      });
    }
    const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    child.send("stop");
    const [code, signal] = await exited;
    assert.equal(code, 0, `benchmark cleanup failed (${signal})\n${output}`);
    if (trace) {
      await new Promise<void>((resolve, reject) => {
        trace.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      for (const [sample, result] of samples.entries()) {
        result.gcTrace = readGatewayGcTrace(tracePath, `workspace-sample-${sample}`);
      }
    }
    return { moduleLoadMs: ready.moduleLoadMs, samples };
  } finally {
    trace?.destroy();
    await stopChild(child);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Workspace computation benchmark (synthetic files and isolated state)

node --import ./scripts/tsx.mjs scripts/bench-workspace-computation.ts [options]
  --baseline <root>    Optional frozen baseline checkout with ready dependencies
  --candidate <root>   Candidate checkout (default: current directory)
  --source-commit <sha> Archive revision supplied by operator; single candidate only, not independently verified
  --scenarios <list>   inventory,manifest,delta,unchanged,compare,reconcile,checkpoint (default: all)
  --sizes <list>       Entries per workspace (default: 1000; max: 100000)
  --concurrency <list> Independent workspaces (default: 1; max: 4)
  --runs <n>           Warm measured samples (default: 3)
  --warmup <n>         Extra warmup samples after separately reported cold sample (default: 1)
  --file-bytes <n>     Bytes per file (default: 1024; inventory capped at 4 GiB)
  --changed-files <n>  Changed files in delta/compare/reconcile/checkpoint (default: 1; range: 0–5000)
  --timeout-ms <n>     Per-operation/probe deadline (default: 300000)
  --prepare-root <dir> Seed fixtures only into a new persistent directory
  --reuse-root <dir>   Measure prepared fixtures (same scenario/size/concurrency/source)
  --start-at <ms>      Coordinated epoch time for first warm measurement (one case only)
  --start-barrier <path> Write <path>.ready after warmup, wait for <path>.go before measuring
  --sampling-interval <bytes> Main-isolate allocation sampling; 0 disables (default: 0)
  --output <path>      Write JSON report
  --json              Print JSON report
  --help              Show usage

CPU includes Node worker threads, but excludes spawned Git processes. Peak RSS is
sampled externally on macOS/Linux; process high-water RSS is also recorded.
Cold means the first owner/pool invocation; fixture creation warms filesystem caches.
Timer interval drift supplements the native event-loop histogram for synchronous stalls.
The HTTP probe measures the owner process, not a full Gateway RPC workload.`);
    return;
  }
  const variants = [
    ...(options.baseline ? [{ label: "baseline", root: options.baseline }] : []),
    { label: "candidate", root: options.candidate },
  ];
  assert(!(options.prepareRoot && options.reuseRoot), "choose prepare-root or reuse-root");
  assert(
    !(options.sourceCommit && options.baseline),
    "--source-commit requires a single candidate",
  );
  assert(!(options.startAt && options.startBarrier), "choose start-at or start-barrier");
  if (options.startAt !== undefined || options.startBarrier !== undefined) {
    assert.equal(
      variants.length *
        options.scenarios.length *
        options.sizes.length *
        options.concurrency.length,
      1,
      "coordinated start requires one source/scenario/size/concurrency",
    );
  }
  const sources = await Promise.all(
    variants.map(async (variant) => ({
      ...variant,
      commit:
        options.sourceCommit ??
        (await exec("git", ["-C", variant.root, "rev-parse", "HEAD"])).stdout.trim(),
      dirty: options.sourceCommit
        ? null
        : Boolean(
            (
              await exec("git", [
                "-C",
                variant.root,
                "status",
                "--porcelain",
                "--untracked-files=no",
              ])
            ).stdout.trim(),
          ),
      provenance: options.sourceCommit
        ? "operator-supplied archive revision; not independently verified"
        : "checkout Git metadata",
    })),
  );
  if (options.prepareRoot) {
    await fs.mkdir(options.prepareRoot);
  }
  const temporary =
    options.prepareRoot ??
    options.reuseRoot ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-benchmark-")));
  const results: Array<{
    scenario: Scenario;
    size: number;
    concurrency: number;
    variant: string;
    moduleLoadMs: number;
    samples: Sample[];
  }> = [];
  try {
    for (const scenario of options.scenarios) {
      for (const size of options.sizes) {
        for (const concurrency of options.concurrency) {
          let expected: string[] | undefined;
          for (const variant of variants) {
            process.stderr.write(
              `[workspace-bench] ${variant.label} ${scenario} entries=${size} concurrency=${concurrency}\n`,
            );
            const root = path.join(
              temporary,
              `${scenario}-${size}-${concurrency}-${variant.label}`,
            );
            const fixtureFile = path.join(root, "fixture.json");
            const fixture: Fixture = options.reuseRoot
              ? JSON.parse(await fs.readFile(fixtureFile, "utf8"))
              : await createFixture({
                  root,
                  source: variant.root,
                  scenario,
                  size,
                  concurrency,
                  options,
                });
            if (options.reuseRoot) {
              assert.equal(fixture.source, variant.root, "prepared fixture source differs");
              assert.equal(
                fixture.fileBytes,
                options.fileBytes,
                "prepared fixture file size differs",
              );
              assert.equal(
                fixture.changedEntries.length,
                ["delta", "compare", "reconcile", "checkpoint"].includes(scenario)
                  ? options.changedFiles
                  : 0,
                "prepared fixture changed count differs",
              );
              fixture.startAt = options.startAt;
              fixture.startBarrier = options.startBarrier;
              fixture.startSample = options.warmup + 1;
              fixture.samplingInterval = options.samplingInterval;
              fixture.timeoutMs = options.timeoutMs;
            }
            if (options.prepareRoot) {
              await fs.writeFile(fixtureFile, JSON.stringify(fixture));
              continue;
            }
            const result = await runSource(fixture, options);
            for (const sample of result.samples) {
              expected ??= sample.evidence;
              assert.deepEqual(
                sample.evidence,
                expected,
                "results differ between samples or source versions",
              );
            }
            results.push({ scenario, size, concurrency, variant: variant.label, ...result });
            if (!options.reuseRoot) {
              await fs.rm(root, { recursive: true, force: true });
            }
          }
        }
      }
    }
    emitBenchmarkReport(
      {
        schemaVersion: 1,
        benchmark: "workspace-computation",
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuCount: os.availableParallelism(),
        measurementScope: {
          cold: "First owner invocation after module loading; filesystem caches are not flushed",
          cpu: "Node process including worker threads, excluding spawned Git processes",
          requests: "External HTTP probes against the owner process, not full Gateway RPCs",
          memory:
            "Owner process including worker threads; excludes fixture generator and Git processes",
          allocation:
            "Main-isolate V8 sampled allocated bytes including collected objects; excludes workers and Git; compare separate equally instrumented runs",
          reconciliation:
            "Real staged apply per invocation, after a sparse staged-write burst; no file-watch callback or Gateway is simulated. Journal adapter is in memory.",
          checkpoint:
            "Prepared managed workspace checkpoint, including capture, real Git staging/application and SQLite receipts. Synthetic file edits precede each checkpoint; no model or container is invoked.",
        },
        sources,
        options,
        results,
      },
      options,
      (report) =>
        report.results.map((result) => {
          const warm = result.samples.filter((sample) => sample.phase === "warm");
          const wall = summarize(warm.map((sample) => sample.wallMs));
          return `${result.variant} ${result.scenario} ${result.size} x ${result.concurrency}: warm wall p50=${wall.p50.toFixed(1)} ms, p95=${wall.p95.toFixed(1)} ms (n=${wall.count}${wall.count < 200 ? "; context only" : ""})`;
        }),
    );
  } finally {
    if (!options.prepareRoot && !options.reuseRoot) {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

await runBenchmarkEntrypoint("workspace-computation", async () => {
  if (process.argv[2] === "--worker") {
    try {
      await childMain(process.argv[3]!);
    } catch (error) {
      process.send?.({
        type: "error",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      throw error;
    } finally {
      process.disconnect?.();
    }
  } else {
    await main();
  }
});
