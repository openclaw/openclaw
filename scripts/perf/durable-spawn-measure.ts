/**
 * Linux fork cost at the real spawn owner, with an already-ready small broker.
 * node --import ./scripts/tsx.mjs scripts/perf/durable-spawn-measure.ts \
 *   --rss-mib 2048 --mappings 2000 --samples 5 --commands 20
 * --control compares two identical native arms. Run it separately from ABAB.
 * --broker-entry selects an independently bundled copy of the existing worker.
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
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { spawnProcess } from "../../src/process/spawn-utils.js";
import { runInDetachedAsyncContext } from "../../src/shared/detached-async-context.js";

const { values } = parseArgs({
  options: {
    "rss-mib": { type: "string", default: "2048" },
    mappings: { type: "string", default: "2000" },
    samples: { type: "string", default: "5" },
    commands: { type: "string", default: "20" },
    control: { type: "boolean", default: false },
    "broker-entry": { type: "string" },
  },
});
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
      return { dispatchMs, readyMs, wallMs };
    }),
  );
}

type Row = Awaited<ReturnType<typeof command>>;
const rows: Array<{
  arm: string;
  sample: number;
  hostNativeCalls: number;
  nativeBlockingMs: number;
  threadCpuMs: number;
  processCpuMs: number;
  brokerCpuTicks: number;
  childCpuTicks: number;
  allocatedBytes: number;
  commands: Row[];
}> = [];
const summarize = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    median:
      (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
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
      assert.equal(nativeCalls, !values.control && arm === "after" ? 0 : commands);
      rows.push({
        arm,
        sample,
        hostNativeCalls: nativeCalls,
        nativeBlockingMs,
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
      fixture: { rssMiB, mappingCount, samples, commands, control: values.control },
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
                selected.flatMap((row) => row.commands.map((item) => item.readyMs)),
              ),
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
}
