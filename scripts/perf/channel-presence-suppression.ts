/**
 * Owner benchmark: suppressed ambient discovery with 40 synthetic channel plugins.
 * Run the same script in base and candidate checkouts, alternating revisions:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/channel-presence-suppression.ts \
 *   --iterations 5000 --mode timing --output .local/channel-presence-timing.json
 * Repeat with --mode allocation. Only the separate allocation pass enables the
 * inspector; its samples include objects collected by minor and major GC.
 * Discovery is prepared in memory; no operator state or plugin files are read.
 * This measures the real owner function, not whole-Gateway startup latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { listPotentialConfiguredChannelPresenceSignals } from "../../src/channels/config-presence.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../../src/plugins/discovery.types.js";
import { writeBenchmarkJson } from "../lib/benchmark-harness.mts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 5000,
});
assert(values.mode === "timing" || values.mode === "allocation", "invalid --mode");
assert(global.gc, "Run with --expose-gc");
const channelIds = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
const discovery: PluginDiscoveryResult = {
  candidates: channelIds.map((id) => ({
    idHint: id,
    origin: "bundled",
    rootDir: `/synthetic/plugins/${id}`,
    source: `/synthetic/plugins/${id}/index.js`,
    packageManifest: { channel: { id } },
  })),
  diagnostics: [],
};
const config: OpenClawConfig = {
  channels: Object.fromEntries(
    channelIds.map((id) => [id, { endpoint: `https://${id}.example.test`, enabled: true }]),
  ),
};
const env = Object.fromEntries(
  channelIds.map((id) => [`${id.replaceAll("-", "_").toUpperCase()}_TOKEN`, "synthetic-token"]),
);
const options = {
  ambientEnvTriggers: "suppress" as const,
  includePersistedAuthState: false,
  discovery,
};
const expected = channelIds.map((channelId) => ({ channelId, source: "config" }));
let lastSignals: ReturnType<typeof listPotentialConfiguredChannelPresenceSignals> = [];
function run(count: number): number {
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    lastSignals = listPotentialConfiguredChannelPresenceSignals(config, env, options);
    checksum += lastSignals.length;
  }
  return checksum;
}
run(250);
assert.deepEqual(lastSignals, expected);
global.gc();
await nextTurn();
await nextTurn();

const inspector = new Session();
const gcDurations: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcDurations.push(entry.duration);
  }
});
const cpuUsage = (previous?: NodeJS.CpuUsage) =>
  typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage(previous)
    : process.cpuUsage(previous);
try {
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuStart = cpuUsage();
  const start = performance.now();
  const checksum = run(iterations);
  const wallMs = performance.now() - start;
  const cpu = cpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  const allocation =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  assert.equal(checksum, iterations * channelIds.length);
  assert.deepEqual(lastSignals, expected);
  const sampledBytes = allocation?.profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  global.gc();
  const report = {
    mode: values.mode,
    node: process.version,
    iterations,
    plugins: channelIds.length,
    configuredChannels: channelIds.length,
    checksum,
    outputSha256: createHash("sha256").update(JSON.stringify(lastSignals)).digest("hex"),
    hostLoad: { before: hostLoadBefore, after: loadavg() },
    ...(values.mode === "timing"
      ? {
          wallMs,
          wallUsPerOperation: (wallMs * 1000) / iterations,
          cpuScope: typeof process.threadCpuUsage === "function" ? "main-thread" : "process",
          cpuMs: (cpu.user + cpu.system) / 1000,
          cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
          gc: {
            count: gcDurations.length,
            totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
            maxMs: Math.max(0, ...gcDurations),
          },
        }
      : { sampledBytes, sampledBytesPerOperation: sampledBytes! / iterations }),
    memory: { before: memoryBefore, after: memoryAfter, postGc: process.memoryUsage() },
  };
  if (values.output) {
    writeBenchmarkJson(report, values.output);
  }
  console.log(JSON.stringify(report));
} finally {
  observer.disconnect();
  inspector.disconnect();
}
