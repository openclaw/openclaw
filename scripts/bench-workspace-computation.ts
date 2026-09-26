// Synthetic owner-boundary benchmark; each source runs in an isolated Node process.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
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
import { stopChild } from "./lib/gateway-bench-child.ts";

const exec = promisify(execFile);
const scenarios = ["inventory", "manifest", "delta", "unchanged", "compare"] as const;
type Scenario = (typeof scenarios)[number];
type Options = {
  baseline?: string;
  candidate: string;
  scenarios: Scenario[];
  sizes: number[];
  concurrency: number[];
  runs: number;
  warmup: number;
  fileBytes: number;
  changedFiles: number;
  timeoutMs: number;
  output?: string;
  json: boolean;
  help: boolean;
};
type Fixture = {
  root: string;
  source: string;
  scenario: Scenario;
  size: number;
  concurrency: number;
  timeoutMs: number;
  baseRef: string;
  currentRef: string;
  inventorySha256: string;
  changedEntries: WorkerWorkspaceManifestEntry[];
};
type Measurement = {
  wallMs: number;
  cpuMs: number;
  entriesPerSecond: number;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
  intervalDelayMs: Summary;
  eventLoopUtilization: number;
  memoryBefore: NodeJS.MemoryUsage;
  memoryAfter: NodeJS.MemoryUsage;
  processMaxRssBytes: number;
  workerTasks: Array<Record<string, unknown>>;
};
type Summary = { count: number; min: number; p50: number; p95: number; p99: number; max: number };
type Sample = Measurement & {
  phase: "cold" | "warmup" | "warm";
  requestLatencyMs: Summary;
  externalPeakRssBytes: number | null;
  requestFailures: number;
  evidence: string[];
};
type ChildMessage =
  | { type: "ready"; port: number; moduleLoadMs: number }
  | { type: "measured"; value: Measurement }
  | { type: "verified"; evidence: string[] }
  | { type: "error"; message: string };

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const nameAt = (index: number) => `file-${String(index).padStart(6, "0")}.txt`;

function summarize(values: number[]): Summary {
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
        options.runs = parseBenchmarkInteger(value, "--runs", 1, 100);
      },
      "--warmup": (options, value) => {
        options.warmup = parseBenchmarkInteger(value, "--warmup", 0, 10);
      },
      "--file-bytes": (options, value) => {
        options.fileBytes = parseBenchmarkInteger(value, "--file-bytes", 1, 64 * 1024 * 1024);
      },
      "--changed-files": (options, value) => {
        options.changedFiles = parseBenchmarkInteger(value, "--changed-files", 1, 5_000);
      },
      "--timeout-ms": (options, value) => {
        options.timeoutMs = parseBenchmarkInteger(value, "--timeout-ms", 1_000, 3_600_000);
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
}): Promise<Fixture> {
  const { root, source, scenario, size, concurrency, options } = params;
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
  const changedFiles = scenario === "delta" || scenario === "compare" ? options.changedFiles : 0;
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
    if (scenario === "inventory" || scenario === "delta" || scenario === "unchanged") {
      await exec("git", ["-c", `core.hooksPath=${os.devNull}`, "init", "--quiet", workspace], {
        env: { ...isolatedEnv(root), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
      });
    }
    if (scenario === "inventory" || scenario === "manifest") {
      let next = 0;
      await Promise.all(
        Array.from({ length: 32 }, async () => {
          while (next < size) {
            await fs.writeFile(path.join(workspace, nameAt(next++)), content, { mode: 0o644 });
          }
        }),
      );
    } else if (scenario !== "compare") {
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
    inventorySha256: digest(entries.map((entry) => `${entry.path}\0`).join("")),
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
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
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
          typeof import("../src/gateway/worker-environments/workspace-reconcile-core.js")
        >(fixture.source, "src/gateway/worker-environments/workspace-reconcile-core.ts")
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
  const baseRaw = staging ? await fs.readFile(path.join(fixture.root, "base.json"), "utf8") : "";
  const currentRaw = staging
    ? await fs.readFile(path.join(fixture.root, "current.json"), "utf8")
    : "";
  const parser =
    fixture.scenario === "compare"
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
  const moduleLoadMs = performance.now() - loadedAt;
  const server = createServer((_request, response) => response.writeHead(200).end("ready\n"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  process.send?.({ type: "ready", port: address.port, moduleLoadMs });
  let sequence = 0;
  const taskEvents: Array<Record<string, unknown>> = [];
  const diagnostics = channel("openclaw.worker.task");
  const observe = (event: unknown) => {
    taskEvents.push(event as Record<string, unknown>);
  };
  diagnostics.subscribe(observe);
  let stopIntervalDelay: (() => number[]) | undefined;
  try {
    while ((await nextCommand()) === "run") {
      const sample = sequence++;
      taskEvents.length = 0;
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      await delay(20);
      histogram.reset();
      stopIntervalDelay = startBenchmarkIntervalDelay();
      const memoryBefore = process.memoryUsage();
      const cpu = process.cpuUsage();
      const utilization = performance.eventLoopUtilization();
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
            const result = await manifests.readActualWorkspaceManifest({
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
      const usedCpu = process.cpuUsage(cpu);
      const eventLoopUtilization = performance.eventLoopUtilization(utilization).utilization;
      const memoryAfter = process.memoryUsage();
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
        intervalDelayMs,
        eventLoopUtilization,
        memoryBefore,
        memoryAfter,
        processMaxRssBytes: process.resourceUsage().maxRSS * 1_024,
        workerTasks: [...taskEvents],
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
    await lifecycle.drainGlobalSingletonLifecycleState();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.disconnect?.();
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
  const fixturePath = path.join(fixture.root, "fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
  const child = fork(fileURLToPath(import.meta.url), ["--worker", fixturePath], {
    cwd: fixture.source,
    execArgv: ["--import", path.join(fixture.source, "scripts/tsx.mjs")],
    env: isolatedEnv(fixture.root),
    detached: process.platform !== "win32",
    silent: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
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
    assert.equal(ready.type, "ready");
    if (ready.type !== "ready") {
      throw new Error("child did not become ready");
    }
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
    return { moduleLoadMs: ready.moduleLoadMs, samples };
  } finally {
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
  --scenarios <list>   inventory,manifest,delta,unchanged,compare (default: all)
  --sizes <list>       Entries per workspace (default: 1000; max: 100000)
  --concurrency <list> Independent workspaces (default: 1; max: 4)
  --runs <n>           Warm measured samples (default: 3)
  --warmup <n>         Extra warmup samples after separately reported cold sample (default: 1)
  --file-bytes <n>     Bytes per file (default: 1024; inventory capped at 4 GiB)
  --changed-files <n>  Changed files in delta/compare scenarios (default: 1; max: 5000)
  --timeout-ms <n>     Per-operation/probe deadline (default: 300000)
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
  const sources = await Promise.all(
    variants.map(async (variant) => ({
      ...variant,
      commit: (await exec("git", ["-C", variant.root, "rev-parse", "HEAD"])).stdout.trim(),
      dirty: Boolean(
        (
          await exec("git", ["-C", variant.root, "status", "--porcelain", "--untracked-files=no"])
        ).stdout.trim(),
      ),
    })),
  );
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-benchmark-"));
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
            const fixture = await createFixture({
              root,
              source: variant.root,
              scenario,
              size,
              concurrency,
              options,
            });
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
            await fs.rm(root, { recursive: true, force: true });
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
        },
        sources,
        options,
        results,
      },
      options,
      (report) =>
        report.results.map((result) => {
          const warm = result.samples.filter((sample) => sample.phase === "warm");
          return `${result.variant} ${result.scenario} ${result.size} x ${result.concurrency}: warm wall p50=${summarize(warm.map((sample) => sample.wallMs)).p50.toFixed(1)} ms; HTTP p99 max=${Math.max(...warm.map((sample) => sample.requestLatencyMs.p99)).toFixed(1)} ms`;
        }),
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
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
      process.disconnect?.();
      throw error;
    }
  } else {
    await main();
  }
});
