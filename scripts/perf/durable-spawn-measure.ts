/**
 * Linux fork cost at the real spawn owner, with an already-ready small broker.
 * node --import ./scripts/tsx.mjs scripts/perf/durable-spawn-measure.ts \
 *   --rss-mib 2048 --mappings 2000 --samples 5 --commands 20
 * --control compares two identical native arms. Run it separately from ABAB.
 * --broker-entry selects an independently bundled copy of the existing worker.
 * --owner container or git exercises those real command owners instead of raw spawn.
 * The container fixture is a synthetic podman executable, not a container engine.
 * Prepare a standalone Linux bundle on the development host:
 *   node --import ./scripts/tsx.mjs scripts/perf/durable-spawn-measure.ts --prepare /task/proof
 *   node /task/proof/measure.mjs --broker-entry /task/proof/broker.mjs \
 *     --owner container --rss-mib 4096 --samples 5 --commands 20
 * --cpu-profile /task/profile writes per-batch main-thread CPU profiles; run separately
 * from acceptance timing because profiling changes overhead.
 * Both arms use the current source: this isolates transport cost, not a patch speedup.
 *
 * Acceptance (before running): every command returns the same bytes/status;
 * candidate host native launches are zero; synchronous dispatch blocking falls;
 * flag any >=20% regression in owner latency, CPU or allocation for review.
 * Report median/p95/spread over serial, alternating samples, plus A/A controls.
 * Startup/imports/resident fixture construction are outside the timed interval.
 *
 * This isolates the production spawn transport, not a full Gateway/systemd test.
 * Its resident pages and virtual mappings exercise fork's actual parent cost;
 * unrelated database/workspace padding would never be read by this owner.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs, { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { execContainerRaw } from "../../src/agents/sandbox/container-engine.js";
import { executeGitCommand } from "../../src/infra/git-exec.js";
import { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { spawnProcess } from "../../src/process/spawn-utils.js";
import { runInDetachedAsyncContext } from "../../src/shared/detached-async-context.js";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    "cpu-profile": { type: "string" },
    owner: { type: "string", default: "raw" },
    "rss-mib": { type: "string", default: "2048" },
    mappings: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
    commands: { type: "string", default: "20" },
    control: { type: "boolean", default: false },
    "broker-entry": { type: "string" },
  },
});
if (values.prepare) {
  const directory = path.resolve(values.prepare);
  fs.mkdirSync(directory);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { build } = await import("esbuild");
  const options = {
    absWorkingDir: root,
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    external: ["*.node", "esbuild"],
    define: { WORKER_DEPLOY_BUILD: "false" },
    banner: {
      js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);',
    },
    logLevel: "warning" as const,
  };
  for (const [source, output] of [
    ["scripts/perf/durable-spawn-measure.ts", "measure.mjs"],
    ["src/process/spawn-broker/worker.ts", "broker.mjs"],
  ]) {
    await build({ ...options, entryPoints: [source!], outfile: path.join(directory, output!) });
  }
  for (const name of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
    fs.copyFileSync(path.join(root, "src/state", name), path.join(directory, name));
  }
  const provenance = {
    commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    bundles: Object.fromEntries(
      ["measure.mjs", "broker.mjs"].map((name) => [
        name,
        createHash("sha256")
          .update(fs.readFileSync(path.join(directory, name)))
          .digest("hex"),
      ]),
    ),
  };
  fs.writeFileSync(path.join(directory, "source.json"), JSON.stringify(provenance));
  console.log(JSON.stringify({ directory, ...provenance }));
  process.exit(0);
}
assert(["raw", "container", "git"].includes(values.owner));
assert.equal(process.platform, "linux", "Linux fork and /proc measurement only");
const rssMiB = Number(values["rss-mib"]);
const mappingCount = Number(values.mappings);
const samples = Number(values.samples);
const commands = Number(values.commands);
for (const value of [rssMiB, mappingCount, samples, commands]) {
  assert(Number.isSafeInteger(value) && value >= 0);
}
assert(samples >= 5 && commands > 0);
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26.12+");
const broker = createSpawnBrokerHost(
  values["broker-entry"] ? { workerUrl: pathToFileURL(values["broker-entry"]) } : {},
);
await broker.ready();
assert(broker.pid);

function processShape(pid = process.pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return {
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]),
    sizeKiB: Number(/^VmSize:\s+(\d+)/m.exec(status)?.[1]),
    mappings: readFileSync(`/proc/${pid}/maps`, "utf8").trim().split("\n").length,
  };
}

function cpuTicks(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // Linux /proc stat fields 14/15; report ticks instead of assuming USER_HZ.
  return {
    own: Number(fields[11]) + Number(fields[12]),
    children: Number(fields[13]) + Number(fields[14]),
  };
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-spawn-owner-"));
const input = Buffer.from("synthetic stdin\n");
const environment = {
  ...process.env,
  PATH: `${fixture}:${process.env.PATH}`,
  SPAWN_FIXTURE: "literal value",
};
const podmanArgs = [
  "exec",
  "synthetic-container",
  "literal argument",
  "$not-expanded",
  "--flag=value",
];
if (values.owner === "container") {
  fs.writeFileSync(
    path.join(fixture, "podman"),
    `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({parent: process.ppid, cwd: process.cwd(), args: process.argv.slice(2), env: process.env.SPAWN_FIXTURE, input: fs.readFileSync(0).toString('hex')}));
process.stderr.write('synthetic stderr\\n');
`,
    { mode: 0o700 },
  );
} else if (values.owner === "git") {
  childProcess.execFileSync("git", ["init", "--quiet", fixture]);
}
const expectedHash = createHash("sha1")
  .update(`blob ${input.length}\0`)
  .update(input)
  .digest("hex");

const retained = Buffer.allocUnsafe(rssMiB * 1024 * 1024);
for (let offset = 0; offset < retained.length; offset += 4096) {
  retained[offset] = 1;
}
// Each bounded Wasm memory gets its own protected reservation, separating VMA
// cost from the resident-buffer sweep. Record actual /proc counts, not estimates.
const mappings = Array.from(
  { length: mappingCount },
  () => new WebAssembly.Memory({ initial: 1, maximum: 1 }),
);
let nativeCalls = 0;
let nativeBlockingMs = 0;
let brokerCalls = 0;
const brokerSpawnExeca = broker.spawnExeca.bind(broker);
broker.spawnExeca = (...args) => {
  brokerCalls++;
  return brokerSpawnExeca(...args);
};
const nativeSpawn = childProcess.spawn;
const measuredSpawn = (...args: Parameters<typeof nativeSpawn>) => {
  const start = performance.now();
  nativeCalls += 1;
  try {
    return nativeSpawn(...args);
  } finally {
    nativeBlockingMs += performance.now() - start;
  }
};
Object.defineProperty(childProcess, "spawn", { value: measuredSpawn });
syncBuiltinESMExports();

async function command(brokered: boolean) {
  return runInDetachedAsyncContext(() =>
    runWithSpawnBroker(brokered ? broker : undefined, async () => {
      const start = performance.now();
      const blockingBefore = nativeBlockingMs;
      if (values.owner !== "raw") {
        const pending =
          values.owner === "container"
            ? execContainerRaw(
                { id: "podman", command: "podman", displayName: "Podman", baseEnv: environment },
                podmanArgs,
                { input },
              )
            : executeGitCommand(fixture, ["hash-object", "--stdin"], {
                input,
                baseEnv: environment,
              });
        const dispatchMs = performance.now() - start;
        const result = await pending;
        const wallMs = performance.now() - start;
        assert.equal(result.code, 0);
        if (values.owner === "container") {
          assert.deepEqual(JSON.parse(result.stdout.toString()), {
            parent: brokered ? broker.pid : process.pid,
            cwd: process.cwd(),
            args: podmanArgs,
            env: "literal value",
            input: input.toString("hex"),
          });
          assert.equal(result.stderr.toString(), "synthetic stderr\n");
        } else {
          assert.equal(result.stdout.toString(), `${expectedHash}\n`);
          assert.equal(result.stderr.toString(), "");
        }
        return {
          dispatchMs,
          readyMs: undefined,
          wallMs,
          nativeBlockingMs: nativeBlockingMs - blockingBefore,
        };
      }
      const child = spawnProcess("/bin/sh", ["-c", "printf 'spawn-fixture\\n'"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const dispatchMs = performance.now() - start;
      let stdout = "";
      let stderr = "";
      const closed = once(child, "close");
      await once(child, "spawn");
      const readyMs = performance.now() - start;
      assert(child.stdout && child.stderr);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const [code, signal] = await closed;
      const wallMs = performance.now() - start;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.equal(stdout, "spawn-fixture\n");
      assert.equal(stderr, "");
      return { dispatchMs, readyMs, wallMs, nativeBlockingMs: nativeBlockingMs - blockingBefore };
    }),
  );
}

type Row = Awaited<ReturnType<typeof command>>;
const rows: Array<{
  arm: string;
  sample: number;
  hostNativeCalls: number;
  nativeBlockingMs: number;
  brokerCalls: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  threadCpuMs: number;
  processCpuMs: number;
  brokerCpuTicks: number;
  childCpuTicks: number;
  allocatedBytes: number;
  commands: Row[];
}> = [];
const summarize = (numbers: number[]) => {
  if (numbers.length === 0) {
    return undefined;
  }
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};

try {
  await command(false);
  await command(true);
  const shape = processShape();
  const brokerShape = processShape(broker.pid);
  for (let sample = 0; sample < samples; sample += 1) {
    const arms = sample % 2 === 0 ? ["before", "after"] : ["after", "before"];
    for (const arm of arms) {
      nativeCalls = 0;
      nativeBlockingMs = 0;
      brokerCalls = 0;
      const eventLoop = monitorEventLoopDelay({ resolution: 1 });
      eventLoop.enable();
      await delay(10);
      const profiler = values["cpu-profile"] ? new Session() : undefined;
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      const brokerCpuBefore = cpuTicks(broker.pid);
      const childCpuBefore = cpuTicks(process.pid).children;
      const allocatedBefore = getHeapStatistics().total_allocated_bytes;
      const cpu = process.cpuUsage();
      const threadCpu = process.threadCpuUsage();
      const batch: Row[] = [];
      for (let index = 0; index < commands; index += 1) {
        batch.push(await command(!values.control && arm === "after"));
      }
      const threadDelta = process.threadCpuUsage(threadCpu);
      const cpuDelta = process.cpuUsage(cpu);
      const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
      const brokerCpuAfter = cpuTicks(broker.pid);
      await delay(5);
      eventLoop.disable();
      if (profiler) {
        const { profile } = await profiler.post("Profiler.stop");
        profiler.disconnect();
        fs.writeFileSync(
          `${values["cpu-profile"]}-${arm}-${sample}.cpuprofile`,
          JSON.stringify(profile),
        );
      }
      if (values.owner !== "raw") {
        assert.equal(brokerCalls, !values.control && arm === "after" ? commands : 0);
      }
      assert.equal(nativeCalls, !values.control && arm === "after" ? 0 : commands);
      rows.push({
        arm,
        sample,
        hostNativeCalls: nativeCalls,
        nativeBlockingMs,
        brokerCalls,
        eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
        eventLoopMaxMs: eventLoop.max / 1e6,
        threadCpuMs: (threadDelta.user + threadDelta.system) / 1000,
        processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
        brokerCpuTicks: brokerCpuAfter.own - brokerCpuBefore.own,
        childCpuTicks:
          cpuTicks(process.pid).children -
          childCpuBefore +
          brokerCpuAfter.children -
          brokerCpuBefore.children,
        allocatedBytes,
        commands: batch,
      });
    }
  }
  console.log(
    JSON.stringify({
      fixture: {
        owner: values.owner,
        rssMiB,
        mappingCount,
        samples,
        commands,
        control: values.control,
      },
      runtime: {
        node: process.version,
        uv: process.versions.uv,
        arch: process.arch,
        kernel: os.release(),
      },
      load: os.loadavg(),
      shape,
      brokerShape,
      summary: Object.fromEntries(
        ["before", "after"].map((arm) => {
          const selected = rows.filter((row) => row.arm === arm);
          return [
            arm,
            {
              dispatchMs: summarize(
                selected.flatMap((row) => row.commands.map((item) => item.dispatchMs)),
              ),
              readyMs: summarize(
                selected.flatMap((row) =>
                  row.commands.flatMap((item) =>
                    item.readyMs === undefined ? [] : [item.readyMs],
                  ),
                ),
              ),
              nativeBlockingMs: summarize(
                selected.flatMap((row) => row.commands.map((item) => item.nativeBlockingMs)),
              ),
              eventLoopP99Ms: summarize(selected.map((row) => row.eventLoopP99Ms)),
              eventLoopMaxMs: summarize(selected.map((row) => row.eventLoopMaxMs)),
              wallMs: summarize(selected.flatMap((row) => row.commands.map((item) => item.wallMs))),
              threadCpuMsPerCommand: summarize(selected.map((row) => row.threadCpuMs / commands)),
              processCpuMsPerCommand: summarize(selected.map((row) => row.processCpuMs / commands)),
              brokerCpuTicksPerCommand: summarize(
                selected.map((row) => row.brokerCpuTicks / commands),
              ),
              childCpuTicksPerCommand: summarize(
                selected.map((row) => row.childCpuTicks / commands),
              ),
              allocatedBytesPerCommand: summarize(
                selected.map((row) => row.allocatedBytes / commands),
              ),
              hostNativeCalls: selected.reduce((sum, row) => sum + row.hostNativeCalls, 0),
            },
          ];
        }),
      ),
      rows,
    }),
  );
  assert.equal(retained.length, rssMiB * 1024 * 1024);
  assert.equal(mappings.length, mappingCount);
} finally {
  Object.defineProperty(childProcess, "spawn", { value: nativeSpawn });
  syncBuiltinESMExports();
  await broker.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
