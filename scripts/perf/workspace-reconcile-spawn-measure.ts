/**
 * Real reconcile/result owners with a retained broker and synthetic large parent.
 * Prepare frozen source on the development checkout, then copy the proof and this
 * script into Linux with Git and Node 26.12+; no installed OpenClaw is required.
 *   node scripts/perf/workspace-reconcile-spawn-measure.ts --prepare /task/proof --base-ref HEAD --native-package /task/fs-safe-linux-arm64-gnu
 *   node workspace-reconcile-spawn-measure.ts --fixture /task/workspace
 *   node workspace-reconcile-spawn-measure.ts --compare /task/proof --fixture /task/workspace
 * Add --control for a separate A/A run. Defaults: five interleaved pairs, two warm
 * iterations, 8192 MiB touched ballast, 62k files/1.143 GB and a 620-file delta.
 * The bounded delta respects the production 768 MiB rollback limit. Empty-entry
 * reconciliation measures the directory-only case without inventing a new journal.
 *
 * Acceptance declared before measurement: byte-identical patch, tree, pack and
 * staged commit; zero candidate host launches; lower synchronous spawn blocking
 * and event-loop delay. No >=20% regression is accepted without explicit analysis.
 * Report cold-owner and warm separately, median/p95/range, and flag >=20% changes
 * in latency, CPU or allocation. First-owner is warm filesystem, not cold disk.
 * Timing includes the real Git worker and broker. Total CPU includes their threads
 * and reaped Git children. Allocation is main-isolate traffic only. A separately
 * selected --cpu-profile writes profiles; never mix profiling into acceptance runs.
 * This is owner-level proof, not a booted Gateway or btrfs/agent-database proof.
 * These owners do not read session databases; database padding would add no work.
 * --native-package is the existing pinned fs-safe optional addon for the target.
 * Install that exact package in isolated proof storage and pass its package root.
 * Samples require it: a zero-path native metadata probe fails before measurement
 * if the addon is missing. No fallback timings qualify as production-shaped proof.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import type { WorkerWorkspaceManifestEntry } from "../../src/gateway/worker-environments/workspace-manifest.js";
import type { createWorkspacePatch } from "../../src/gateway/worker-environments/workspace-reconcile-recovery.js";
import type { workerWorkspaceResultStaging } from "../../src/gateway/worker-environments/workspace-result-staging.js";
import type { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import type { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import type { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    "base-ref": { type: "string", default: "HEAD" },
    "native-package": { type: "string" },
    fixture: { type: "string" },
    compare: { type: "string" },
    sample: { type: "string" },
    "cpu-profile": { type: "string" },
    control: { type: "boolean", default: false },
    samples: { type: "string", default: "5" },
    commands: { type: "string", default: "2" },
    "rss-mib": { type: "string", default: "8192" },
    files: { type: "string", default: "62000" },
    changed: { type: "string", default: "620" },
    "file-bytes": { type: "string", default: "18432" },
  },
});
const script = fileURLToPath(import.meta.url);
const samplePrefix = "workspace-reconcile-measure:";
const sourceRoot = path.resolve(path.dirname(script), "../..");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const git = (root: string, args: string[], input?: Uint8Array) =>
  childProcess.execFileSync("git", ["-C", root, ...args], {
    env: environment,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
type Fixture = {
  files: number;
  bytes: number;
  base: WorkerWorkspaceManifestEntry[];
  current: WorkerWorkspaceManifestEntry[];
  baseManifestRaw: string;
  currentManifestRaw: string;
};
type Measurement = {
  phase: string;
  operation: string;
  fingerprint: string;
  [key: string]: number | string;
};

if (values.prepare) {
  const directory = path.resolve(values.prepare);
  fs.mkdirSync(directory);
  // The production temp-root resolver loads this supported export dynamically.
  // Preserve the pinned package instead of replacing the resolver in the owner.
  fs.cpSync(
    fs.realpathSync(path.join(sourceRoot, "node_modules/@openclaw/fs-safe")),
    path.join(directory, "node_modules/@openclaw/fs-safe"),
    { recursive: true },
  );
  assert(values["native-package"], "Supply the target's pinned fs-safe optional package");
  const nativeDirectory = path.resolve(values["native-package"]);
  const nativePackage = JSON.parse(
    fs.readFileSync(path.join(nativeDirectory, "package.json"), "utf8"),
  );
  const fsSafe = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "node_modules/@openclaw/fs-safe/package.json"), "utf8"),
  );
  assert.equal(fsSafe.optionalDependencies[nativePackage.name], nativePackage.version);
  assert(nativePackage.name.startsWith("@openclaw/fs-safe-"));
  fs.cpSync(nativeDirectory, path.join(directory, "node_modules", nativePackage.name), {
    recursive: true,
  });
  const { build } = await import("esbuild");
  const changed = git(sourceRoot, [
    "diff",
    "--name-only",
    values["base-ref"],
    "--",
    "src",
    "packages",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const baseline = new Set(changed);
  const provenance: {
    baseCommit: string;
    sourceSha256: Record<string, Record<string, string>>;
    bundleSha256: Record<string, Record<string, string>>;
    nativeDependency: { name: string; version: string; binarySha256: Record<string, string> };
  } = {
    baseCommit: git(sourceRoot, ["rev-parse", values["base-ref"]]).toString().trim(),
    sourceSha256: {},
    bundleSha256: {},
    nativeDependency: {
      name: nativePackage.name,
      version: nativePackage.version,
      binarySha256: Object.fromEntries(
        fs
          .readdirSync(nativeDirectory)
          .filter((file) => file.endsWith(".node"))
          .map((file) => [file, hash(fs.readFileSync(path.join(nativeDirectory, file)))]),
      ),
    },
  };
  for (const arm of ["before", "after"]) {
    const destination = path.join(directory, arm);
    fs.mkdirSync(destination);
    fs.writeFileSync(
      path.join(destination, "package.json"),
      '{"name":"openclaw","type":"module"}\n',
    );
    const sources: Record<string, string> = {};
    const frozenSources = new Map<string, string>();
    const options = {
      absWorkingDir: sourceRoot,
      bundle: true,
      platform: "node" as const,
      format: "esm" as const,
      external: ["*.node"],
      define: { WORKER_DEPLOY_BUILD: "false" },
      banner: {
        js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);',
      },
      logLevel: "warning" as const,
      plugins: [
        {
          name: "frozen-reconcile-source",
          setup(builder: import("esbuild").PluginBuild) {
            builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, (args) => {
              const relative = path.relative(sourceRoot, args.path);
              if (relative.startsWith("../") || relative.includes("node_modules/")) {
                return undefined;
              }
              const contents =
                frozenSources.get(relative) ??
                (arm === "before" && baseline.has(relative)
                  ? git(sourceRoot, ["show", `${values["base-ref"]}:${relative}`]).toString()
                  : fs.readFileSync(args.path, "utf8"));
              frozenSources.set(relative, contents);
              sources[relative] = hash(contents);
              return {
                contents,
                loader: /\.[cm]?ts$/.test(args.path) ? ("ts" as const) : ("js" as const),
                resolveDir: path.dirname(args.path),
              };
            });
          },
        },
      ],
    };
    await build({
      ...options,
      stdin: {
        contents: [
          'export {createWorkspacePatch} from "./src/gateway/worker-environments/workspace-reconcile-recovery.ts";',
          'export {workerWorkspaceResultStaging} from "./src/gateway/worker-environments/workspace-result-staging.ts";',
          'export {runWithSpawnBroker} from "./src/process/spawn-broker/context.ts";',
          'export {createSpawnBrokerHost} from "./src/process/spawn-broker/host.ts";',
          'export {drainGlobalSingletonLifecycleState} from "./src/shared/global-singleton.ts";',
          'export {readCloneFileMetadata} from "@openclaw/fs-safe/copy";',
        ].join("\n"),
        resolveDir: sourceRoot,
        loader: "ts",
      },
      outfile: path.join(destination, "dist/measure.js"),
    });
    for (const entry of ["process/spawn-broker/worker", "infra/git-operation.worker"]) {
      await build({
        ...options,
        entryPoints: [`src/${entry}.ts`],
        outfile: path.join(destination, `dist/${entry}.js`),
      });
    }
    for (const name of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      for (const parent of ["dist", "dist/infra", "dist/process/spawn-broker"]) {
        fs.copyFileSync(
          path.join(sourceRoot, "src/state", name),
          path.join(destination, parent, name),
        );
      }
    }
    provenance.sourceSha256[arm] = sources;
    provenance.bundleSha256[arm] = Object.fromEntries(
      ["measure", "process/spawn-broker/worker", "infra/git-operation.worker"].map((file) => [
        file,
        hash(fs.readFileSync(path.join(destination, `dist/${file}.js`))),
      ]),
    );
  }
  fs.writeFileSync(path.join(directory, "source.json"), JSON.stringify(provenance));
  console.log(JSON.stringify({ prepared: directory, baseCommit: provenance.baseCommit }));
} else if (values.fixture && !values.compare && !values.sample) {
  const directory = path.resolve(values.fixture);
  const files = Number(values.files),
    changed = Number(values.changed),
    fileBytes = Number(values["file-bytes"]);
  assert([files, changed, fileBytes].every((value) => Number.isSafeInteger(value) && value > 0));
  assert(changed <= files && fileBytes >= 8);
  fs.mkdirSync(directory);
  const root = path.join(directory, "base"),
    staging = path.join(directory, "staging");
  fs.mkdirSync(root);
  fs.mkdirSync(staging);
  const base: WorkerWorkspaceManifestEntry[] = [],
    current: WorkerWorkspaceManifestEntry[] = [];
  const allBase: WorkerWorkspaceManifestEntry[] = [],
    allCurrent: WorkerWorkspaceManifestEntry[] = [];
  const payload = Buffer.alloc(fileBytes, 0x78);
  for (let index = 0; index < files; index++) {
    const relative = `d${Math.floor(index / 100)}/f${index}.txt`;
    if (index % 100 === 0) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    }
    payload.writeUInt32LE(index);
    payload.writeUInt32LE(0, 4);
    fs.writeFileSync(path.join(root, relative), payload);
    const entry: WorkerWorkspaceManifestEntry = {
      path: relative,
      type: "file",
      mode: 0o644,
      size: payload.length,
      sha256: hash(payload),
    };
    allBase.push(entry);
    if (index < changed) {
      fs.mkdirSync(path.dirname(path.join(staging, relative)), { recursive: true });
      payload.writeUInt32LE(1, 4);
      fs.writeFileSync(path.join(staging, relative), payload);
      const replacement = { ...entry, sha256: hash(payload) };
      base.push(entry);
      current.push(replacement);
      allCurrent.push(replacement);
    } else {
      allCurrent.push(entry);
    }
  }
  const manifest = (entries: WorkerWorkspaceManifestEntry[]) =>
    JSON.stringify({
      version: 1,
      baseCommit: null,
      entries: [
        ...[...new Set(entries.map((entry) => path.posix.dirname(entry.path)))].map(
          (entryPath) => ({ path: entryPath, type: "directory", mode: 0o700 }),
        ),
        ...entries,
      ].toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    });
  const fixture: Fixture = {
    files,
    bytes: files * fileBytes,
    base,
    current,
    baseManifestRaw: manifest(allBase),
    currentManifestRaw: manifest(allCurrent),
  };
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify(fixture));
  console.log(JSON.stringify({ fixture: directory, files, bytes: fixture.bytes, changed }));
} else if (values.compare) {
  assert(values.fixture);
  const samples = Number(values.samples);
  assert(Number.isSafeInteger(samples) && samples >= 5);
  const rows: Array<{
    arm: string;
    sample: number;
    diagnostics: string[];
    result: { rows: Measurement[] };
  }> = [];
  const fingerprints = new Map<string, string>();
  for (let sample = 0; sample < samples; sample++) {
    for (const arm of sample % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
      const actual = values.control ? "before" : arm;
      const output: string = childProcess.execFileSync(
        process.execPath,
        [
          script,
          "--sample",
          path.join(path.resolve(values.compare), actual),
          "--fixture",
          path.resolve(values.fixture),
          "--commands",
          values.commands,
          "--rss-mib",
          values["rss-mib"],
        ],
        { env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const lines = output.trim().split("\n");
      const resultLine = lines.findLast((line) => line.startsWith(samplePrefix));
      assert(resultLine, "Sample did not produce its completion record");
      const result: { rows: Measurement[] } = JSON.parse(resultLine.slice(samplePrefix.length));
      for (const row of result.rows) {
        if (fingerprints.has(row.operation)) {
          assert.equal(
            row.fingerprint,
            fingerprints.get(row.operation),
            `Different bytes: ${row.operation}`,
          );
        }
        fingerprints.set(row.operation, row.fingerprint);
      }
      rows.push({
        arm,
        sample,
        diagnostics: lines.filter((line) => !line.startsWith(samplePrefix)),
        result,
      });
      console.error(`completed ${values.control ? "A/A" : "A/B"} ${sample + 1}/${samples} ${arm}`);
    }
  }
  const groups = new Map<string, Measurement[]>();
  for (const row of rows) {
    for (const measurement of row.result.rows) {
      const key = `${row.arm}:${measurement.phase}:${measurement.operation}`;
      const group = groups.get(key) ?? [];
      group.push(measurement);
      groups.set(key, group);
    }
  }
  const summary = Object.fromEntries(
    [...groups].map(([key, measurements]) => [
      key,
      Object.fromEntries(
        Object.keys(measurements[0]!)
          .filter((metric) => typeof measurements[0]![metric] === "number")
          .map((metric) => {
            const sorted = measurements.map((row) => Number(row[metric])).toSorted((a, b) => a - b);
            return [
              metric,
              {
                median:
                  (sorted[Math.floor((sorted.length - 1) / 2)]! +
                    sorted[Math.floor(sorted.length / 2)]!) /
                  2,
                p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                min: sorted[0],
                max: sorted.at(-1),
              },
            ];
          }),
      ),
    ]),
  );
  console.log(
    JSON.stringify({
      control: values.control,
      summary,
      provenance: JSON.parse(fs.readFileSync(path.join(values.compare, "source.json"), "utf8")),
      rows,
    }),
  );
} else if (values.sample) {
  assert.equal(process.platform, "linux");
  assert(values.fixture);
  assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26.12+");
  process.env.FS_SAFE_NATIVE_MODE = "require";
  const rssMiB = Number(values["rss-mib"]),
    commands = Number(values.commands);
  assert(
    Number.isSafeInteger(rssMiB) && rssMiB >= 0 && Number.isSafeInteger(commands) && commands > 0,
  );
  const directory = path.resolve(values.fixture);
  const fixture: Fixture = JSON.parse(
    fs.readFileSync(path.join(directory, "fixture.json"), "utf8"),
  );
  const runtime: {
    createWorkspacePatch: typeof createWorkspacePatch;
    workerWorkspaceResultStaging: typeof workerWorkspaceResultStaging;
    runWithSpawnBroker: typeof runWithSpawnBroker;
    createSpawnBrokerHost: typeof createSpawnBrokerHost;
    drainGlobalSingletonLifecycleState: typeof drainGlobalSingletonLifecycleState;
    readCloneFileMetadata: typeof readCloneFileMetadata;
  } = await import(pathToFileURL(path.join(path.resolve(values.sample), "dist/measure.js")).href);
  await runtime.readCloneFileMetadata([]);
  const broker = runtime.createSpawnBrokerHost();
  await broker.ready();
  assert(broker.pid);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reconcile-measure-"));
  const repository = path.join(scratch, "repository");
  fs.mkdirSync(repository);
  git(repository, ["init", "--quiet", "--object-format=sha1"]);
  const retained = Array.from({ length: Math.ceil(rssMiB / 128) }, (_, index) => {
    const chunk = Buffer.allocUnsafe(Math.min(128, rssMiB - index * 128) * 1024 * 1024);
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      chunk[offset] = 1;
    }
    return chunk;
  });
  const ticks = (pid: number) => {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      own: Number(fields[11]) + Number(fields[12]),
      children: Number(fields[13]) + Number(fields[14]),
    };
  };
  const shape = (pid: number) => ({
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]),
    mappings: fs.readFileSync(`/proc/${pid}/maps`, "utf8").trim().split("\n").length,
  });
  const parentShape = shape(process.pid),
    brokerShape = shape(broker.pid);
  const ticksPerSecond = Number(
    childProcess.execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
  );
  const filesystem = childProcess
    .execFileSync("stat", ["-f", "-c", "%T", directory], { encoding: "utf8" })
    .trim();
  const cgroup = Object.fromEntries(
    ["cpu.max", "memory.max"].map((name) => [
      name,
      fs.existsSync(`/sys/fs/cgroup/${name}`)
        ? fs.readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim()
        : "unavailable",
    ]),
  );
  let nativeCalls = 0,
    nativeBlockingMs = 0,
    brokerCalls = 0;
  const nativeSpawn = childProcess.spawn;
  Object.defineProperty(childProcess, "spawn", {
    value: (...args: Parameters<typeof nativeSpawn>) => {
      nativeCalls++;
      const start = performance.now();
      try {
        return nativeSpawn(...args);
      } finally {
        nativeBlockingMs += performance.now() - start;
      }
    },
  });
  syncBuiltinESMExports();
  const spawnExeca = broker.spawnExeca.bind(broker),
    spawn = broker.spawn.bind(broker);
  broker.spawnExeca = (...args) => {
    brokerCalls++;
    return spawnExeca(...args);
  };
  broker.spawn = (...args) => {
    brokerCalls++;
    return spawn(...args);
  };
  const inspector = values["cpu-profile"] ? new Session() : undefined;
  inspector?.connect();
  const rows: Measurement[] = [];
  try {
    if (inspector) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    for (let iteration = 0; iteration <= commands; iteration++) {
      for (const operation of ["patch", "empty-patch", "stage"]) {
        const loop = monitorEventLoopDelay({ resolution: 1 });
        loop.enable();
        await setTimeout(5);
        loop.reset();
        nativeCalls = 0;
        nativeBlockingMs = 0;
        brokerCalls = 0;
        const beforeBroker = ticks(broker.pid),
          beforeChildren = ticks(process.pid).children;
        const allocation = getHeapStatistics().total_allocated_bytes;
        const cpu = process.cpuUsage(),
          thread = process.threadCpuUsage(),
          start = performance.now();
        const result = await runtime.runWithSpawnBroker(broker, async () => {
          if (operation === "stage") {
            return runtime.workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
              root: repository,
              stagingRoot: path.join(directory, "staging"),
              stagedResultRef: `refs/openclaw/worker-results/measure-${iteration}`,
              baseManifestRef: `sha256:${hash(fixture.baseManifestRaw)}`,
              currentManifestRef: `sha256:${hash(fixture.currentManifestRaw)}`,
              baseManifestRaw: fixture.baseManifestRaw,
              currentManifestRaw: fixture.currentManifestRaw,
              assertCurrent: () => {},
            });
          }
          return runtime.createWorkspacePatch({
            root: path.join(directory, "base"),
            stagingRoot: path.join(directory, "staging"),
            baseEntries: operation === "patch" ? fixture.base : [],
            appliedEntries: operation === "patch" ? fixture.current : [],
          });
        });
        const wallMs = performance.now() - start,
          threadDelta = process.threadCpuUsage(thread),
          cpuDelta = process.cpuUsage(cpu);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
        const afterBroker = ticks(broker.pid);
        const childCpuTicks =
          ticks(process.pid).children -
          beforeChildren +
          afterBroker.children -
          beforeBroker.children;
        await setTimeout(5);
        loop.disable();
        const fingerprint =
          typeof result === "string"
            ? result
            : `${result.baseTree}:${hash(result.basePack)}:${hash(result.patch)}`;
        if (operation === "empty-patch" && typeof result !== "string") {
          assert.equal(result.patch.length, 0);
        }
        rows.push({
          phase: iteration === 0 ? "first-owner" : "warm",
          iteration,
          operation,
          fingerprint,
          nativeCalls,
          brokerCalls,
          totalLaunches: nativeCalls + brokerCalls,
          nativeBlockingMs,
          wallMs,
          threadCpuMs: (threadDelta.user + threadDelta.system) / 1000,
          processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
          totalCpuMs:
            (cpuDelta.user + cpuDelta.system) / 1000 +
            ((afterBroker.own - beforeBroker.own + childCpuTicks) * 1000) / ticksPerSecond,
          allocatedBytes,
          brokerCpuTicks: afterBroker.own - beforeBroker.own,
          childCpuTicks,
          loopP99Ms: loop.percentile(99) / 1e6,
          loopMaxMs: loop.max / 1e6,
        });
      }
    }
    if (inspector) {
      const { profile } = await inspector.post("Profiler.stop");
      fs.writeFileSync(values["cpu-profile"]!, JSON.stringify(profile));
    }
    console.log(
      samplePrefix +
        JSON.stringify({
          node: process.version,
          uv: process.versions.uv,
          kernel: os.release(),
          arch: process.arch,
          load: os.loadavg(),
          parentShape,
          brokerShape,
          filesystem,
          cgroup,
          ticksPerSecond,
          fsSafeNative: "required; zero-path native metadata probe passed",
          fixture: { files: fixture.files, bytes: fixture.bytes, changed: fixture.base.length },
          rssMiB,
          commands,
          rows,
        }),
    );
    assert.equal(
      retained.reduce((sum, chunk) => sum + chunk.length, 0),
      rssMiB * 1024 * 1024,
    );
  } finally {
    inspector?.disconnect();
    Object.defineProperty(childProcess, "spawn", { value: nativeSpawn });
    syncBuiltinESMExports();
    await runtime.drainGlobalSingletonLifecycleState();
    await broker.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} else {
  throw new Error("Select --prepare, --fixture, --compare, or --sample");
}
