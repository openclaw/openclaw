/**
 * Linux inventory fork cost, using frozen source and only synthetic workspace files.
 * Prepare on a checkout with esbuild installed:
 *   node scripts/perf/workspace-inventory-spawn-measure.ts --prepare /task/proof --base-ref HEAD
 * On Linux with Git and Node 26.12+ (copy this script and prepared directory):
 *   node workspace-inventory-spawn-measure.ts --fixture /task/workspace
 *   node workspace-inventory-spawn-measure.ts --compare /task/proof --fixture /task/workspace
 * Add --control for A/A; --samples 5 --commands 5 --rss-mib 2048 --mappings 2000 are defaults.
 * Separate allocation diagnostics: --sample <bundle> --heap-profile <output-prefix> samples
 * each warm inventory command at 1 KiB intervals; do not use its timings for comparison.
 * Preparation builds the original owner from --base-ref and the current owner, sharing each
 * owner's real dependency graph with its broker context. No production module is mocked.
 * Acceptance: identical bytes, zero candidate host forks, lower blocking; flag >=20% increases
 * in latency, CPU or allocation. Report first-owner and warm samples separately. Filesystem
 * caches are warm, not dropped. This measures two real ls-files commands per inventory and
 * pack-objects with file input, not full synchronization, Git-worker selection, or a Gateway.
 * The owner never reads agent databases; padding a 35 GiB database adds no exercised work.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { runWorkspaceInventoryCommandToFile } from "../../src/gateway/worker-environments/workspace-sync-inventory.js";
import type { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import type { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    "base-ref": { type: "string", default: "HEAD" },
    fixture: { type: "string" },
    compare: { type: "string" },
    sample: { type: "string" },
    "heap-profile": { type: "string" },
    control: { type: "boolean", default: false },
    samples: { type: "string", default: "5" },
    commands: { type: "string", default: "5" },
    "rss-mib": { type: "string", default: "2048" },
    mappings: { type: "string", default: "2000" },
  },
});
const script = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(script), "../..");
const owner = "src/gateway/worker-environments/workspace-sync-inventory.ts";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const git = (root: string, args: string[], input?: Uint8Array) =>
  childProcess.execFileSync("git", ["-C", root, ...args], {
    env: environment,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

if (values.prepare) {
  const directory = path.resolve(values.prepare);
  fs.mkdirSync(directory);
  const { build } = await import("esbuild");
  const baseline = childProcess.execFileSync("git", ["show", `${values["base-ref"]}:${owner}`], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  const candidate = fs.readFileSync(path.join(sourceRoot, owner), "utf8");
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
  };
  for (const [arm, contents] of [
    ["before", baseline],
    ["after", candidate],
  ] as const) {
    await build({
      ...options,
      stdin: {
        contents: [
          `export {runWorkspaceInventoryCommandToFile} from "./${owner}";`,
          'export {runWithSpawnBroker} from "./src/process/spawn-broker/context.ts";',
          'export {createSpawnBrokerHost} from "./src/process/spawn-broker/host.ts";',
        ].join("\n"),
        resolveDir: sourceRoot,
        loader: "ts",
      },
      plugins: [
        {
          name: "frozen-inventory-owner",
          setup(builder) {
            builder.onLoad({ filter: /\/workspace-sync-inventory\.ts$/ }, () => ({
              contents,
              loader: "ts",
              resolveDir: path.dirname(path.join(sourceRoot, owner)),
            }));
          },
        },
      ],
      outfile: path.join(directory, `${arm}.mjs`),
    });
  }
  await build({
    ...options,
    entryPoints: ["src/process/spawn-broker/worker.ts"],
    outfile: path.join(directory, "broker.mjs"),
  });
  for (const name of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
    fs.copyFileSync(path.join(sourceRoot, "src/state", name), path.join(directory, name));
  }
  const provenance = {
    baseRef: values["base-ref"],
    baseCommit: childProcess
      .execFileSync("git", ["rev-parse", values["base-ref"]], { cwd: sourceRoot, encoding: "utf8" })
      .trim(),
    beforeSha256: hash(Buffer.from(baseline)),
    afterSha256: hash(Buffer.from(candidate)),
    bundleSha256: Object.fromEntries(
      ["before.mjs", "after.mjs", "broker.mjs"].map((name) => [
        name,
        hash(fs.readFileSync(path.join(directory, name))),
      ]),
    ),
  };
  fs.writeFileSync(path.join(directory, "source.json"), JSON.stringify(provenance));
  console.log(JSON.stringify({ prepared: directory, ...provenance }));
} else if (values.fixture && !values.compare && !values.sample) {
  const directory = path.resolve(values.fixture);
  fs.mkdirSync(directory);
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "pack.threads", "1"]);
  fs.writeFileSync(path.join(directory, ".gitignore"), "ignored/\n");
  const payload = Buffer.alloc(18_432, 0x78);
  for (let index = 0; index < 62_000; index++) {
    const parent = path.join(
      directory,
      index < 31_000 ? "tracked" : "untracked",
      `d${Math.floor(index / 100)}`,
    );
    if (index % 100 === 0) {
      fs.mkdirSync(parent, { recursive: true });
    }
    payload.writeUInt32LE(index);
    fs.writeFileSync(path.join(parent, `f${index}.txt`), payload);
  }
  fs.mkdirSync(path.join(directory, "ignored"));
  fs.writeFileSync(path.join(directory, "ignored", "private.txt"), "synthetic ignored\n");
  git(directory, ["add", "tracked", ".gitignore"]);
  git(directory, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "synthetic inventory",
  ]);
  console.log(
    JSON.stringify({ fixture: directory, files: 62_000, bytes: 62_000 * payload.length }),
  );
} else if (values.compare) {
  assert(values.fixture);
  const samples = Number(values.samples);
  assert(Number.isSafeInteger(samples) && samples >= 5);
  type Measurement = { phase: string; operation: string; [key: string]: number | string };
  const rows: Array<{ arm: string; sample: number; result: { rows: Measurement[] } }> = [];
  for (let sample = 0; sample < samples; sample++) {
    for (const arm of sample % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
      const actual = values.control ? "before" : arm;
      const output = childProcess.execFileSync(
        process.execPath,
        [
          script,
          "--sample",
          path.join(path.resolve(values.compare), `${actual}.mjs`),
          "--fixture",
          path.resolve(values.fixture),
          "--commands",
          values.commands,
          "--rss-mib",
          values["rss-mib"],
          "--mappings",
          values.mappings,
        ],
        { env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const result: { rows: Measurement[] } = JSON.parse(output.trim());
      rows.push({ arm, sample, result });
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
  const rssMiB = Number(values["rss-mib"]),
    mappingCount = Number(values.mappings),
    commands = Number(values.commands);
  for (const value of [rssMiB, mappingCount, commands]) {
    assert(Number.isSafeInteger(value) && value >= 0);
  }
  assert(commands > 0);
  const root = path.resolve(values.fixture);
  const runtime: {
    runWorkspaceInventoryCommandToFile: typeof runWorkspaceInventoryCommandToFile;
    runWithSpawnBroker: typeof runWithSpawnBroker;
    createSpawnBrokerHost: typeof createSpawnBrokerHost;
  } = await import(pathToFileURL(path.resolve(values.sample)).href);
  const broker = runtime.createSpawnBrokerHost({
    workerUrl: pathToFileURL(path.join(path.dirname(path.resolve(values.sample)), "broker.mjs")),
  });
  await broker.ready();
  assert(broker.pid);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-inventory-measure-"));
  const objectList = git(root, ["rev-list", "--objects", "--no-object-names", "HEAD^{tree}"]);
  const inputPath = path.join(scratch, "objects");
  fs.writeFileSync(inputPath, objectList);
  const operations = [
    {
      name: "eligible",
      args: ["ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "-z"],
    },
    {
      name: "ignored",
      args: [
        "ls-files",
        "--full-name",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ":(glob)media/inbound/openclaw-staged-*/**",
      ],
    },
    { name: "pack", args: ["pack-objects", "--stdout"], inputPath },
  ];
  const expected = operations.map((operation) =>
    hash(git(root, operation.args, operation.inputPath ? objectList : undefined)),
  );
  const ticks = (pid: number) => {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return {
      own: Number(fields[11]) + Number(fields[12]),
      children: Number(fields[13]) + Number(fields[14]),
    };
  };
  const shape = (pid: number) => ({
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]),
    mappings: fs.readFileSync(`/proc/${pid}/maps`, "utf8").trim().split("\n").length,
  });
  const retained = Buffer.allocUnsafe(rssMiB * 1024 * 1024);
  for (let offset = 0; offset < retained.length; offset += 4096) {
    retained[offset] = 1;
  }
  const mappings = Array.from(
    { length: mappingCount },
    () => new WebAssembly.Memory({ initial: 1, maximum: 1 }),
  );
  const parentShape = shape(process.pid),
    brokerShape = shape(broker.pid);
  let nativeCalls = 0,
    nativeBlockingMs = 0;
  const nativeSpawn = childProcess.spawn;
  Object.defineProperty(childProcess, "spawn", {
    value: (...args: Parameters<typeof nativeSpawn>) => {
      const start = performance.now();
      nativeCalls++;
      try {
        return nativeSpawn(...args);
      } finally {
        nativeBlockingMs += performance.now() - start;
      }
    },
  });
  syncBuiltinESMExports();
  const rows = [];
  const inspector = values["heap-profile"] ? new Session() : undefined;
  inspector?.connect();
  try {
    for (let iteration = 0; iteration <= commands; iteration++) {
      for (const [index, operation] of operations.entries()) {
        nativeCalls = 0;
        nativeBlockingMs = 0;
        const outputPath = path.join(scratch, `${iteration}-${operation.name}`);
        const beforeBroker = ticks(broker.pid),
          beforeChildren = ticks(process.pid).children;
        const profileInventory = inspector && iteration > 0 && operation.name !== "pack";
        if (profileInventory) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const allocation = getHeapStatistics().total_allocated_bytes;
        const cpu = process.cpuUsage(),
          thread = process.threadCpuUsage(),
          start = performance.now();
        await runtime.runWithSpawnBroker(broker, () =>
          runtime.runWorkspaceInventoryCommandToFile({
            argv: ["git", "-C", root, ...operation.args],
            outputPath,
            inputPath: operation.inputPath,
            signal: AbortSignal.timeout(60_000),
            timeoutMs: 60_000,
            baseEnv: environment,
            ...(operation.name === "pack" ? { maxOutputBytes: 64 * 1024 * 1024 } : {}),
          }),
        );
        const wallMs = performance.now() - start,
          threadDelta = process.threadCpuUsage(thread),
          cpuDelta = process.cpuUsage(cpu);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
        if (profileInventory) {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          fs.writeFileSync(
            `${values["heap-profile"]}-${iteration}-${operation.name}.heapprofile`,
            JSON.stringify(profile),
          );
        }
        const afterBroker = ticks(broker.pid);
        const output = fs.readFileSync(outputPath);
        assert.equal(hash(output), expected[index]);
        rows.push({
          phase: iteration === 0 ? "first-owner" : "warm",
          iteration,
          operation: operation.name,
          nativeCalls,
          nativeBlockingMs,
          wallMs,
          threadCpuMs: (threadDelta.user + threadDelta.system) / 1000,
          processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
          allocatedBytes,
          bytes: output.length,
          brokerCpuTicks: afterBroker.own - beforeBroker.own,
          childCpuTicks:
            ticks(process.pid).children -
            beforeChildren +
            afterBroker.children -
            beforeBroker.children,
        });
      }
    }
    console.log(
      JSON.stringify({
        node: process.version,
        uv: process.versions.uv,
        kernel: os.release(),
        arch: process.arch,
        load: os.loadavg(),
        parentShape,
        brokerShape,
        rssMiB,
        mappingCount,
        commands,
        rows,
      }),
    );
    assert.equal(retained.length, rssMiB * 1024 * 1024);
    assert.equal(mappings.length, mappingCount);
  } finally {
    inspector?.disconnect();
    Object.defineProperty(childProcess, "spawn", { value: nativeSpawn });
    syncBuiltinESMExports();
    await broker.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} else {
  throw new Error("Select --prepare, --fixture, --compare, or --sample");
}
