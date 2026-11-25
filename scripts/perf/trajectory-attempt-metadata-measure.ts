/**
 * Synthetic trajectory-owner proof; no Gateway, model calls, or database writes.
 * Includes metadata building plus recorder capture with 40 plugins and 10 skills.
 * persistedHash covers exact sink bytes with only clocks and event sequences normalized.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   scripts/perf/trajectory-attempt-metadata-measure.ts --mode timing --iterations 2000
 * Repeat with --mode allocation; alternate five base/candidate passes per mode.
 * Base: set OPENCLAW_BENCH_BASELINE_DIR to an absolute repository-relative source
 * overlay and add --import ./scripts/perf/worker-retained-heap-preload.ts after tsx.
 * Both arms use the same fixture and dependency tree. Compare outputHash before
 * interpreting metrics. Only capture timestamps are normalized; argv/env are fixed.
 * Timing CPU/GC is untraced; allocation sampling includes already-collected objects.
 * Acceptance: identical output, fewer repeated projections, and reduced CPU/allocation.
 * Report absolute GC deltas; short owner runs do not establish Gateway tail latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { captureRuntimeConfigWithSource } from "../../src/config/runtime-config-capture-state.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.js";
import { buildTrajectoryRunMetadata } from "../../src/trajectory/metadata.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["timing", "allocation"].includes(values.mode), "Use timing or allocation mode");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "--iterations",
});
assert(iterations <= 100_000, "Use at most 100000 iterations");
// Capture the exact serialized persistence handoff; only SQLite is excluded.
const sinkUrl = `data:text/javascript,${encodeURIComponent(`
let line;
export const readLine = () => line;
export const createSqliteTrajectoryRuntimeSink = async () => ({
  write: (_event, next) => { line = next; }, flush: async () => {},
  describeFlushState: () => undefined,
});`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith("/runtime-store-writer.js")
      ? { url: sinkUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const sink: { readLine(): string } = await import(sinkUrl);
const { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } =
  await import("../../src/trajectory/runtime.js");
hook.deregister();
const recorder = await createTrajectoryRuntimeRecorder({
  sessionId: "synthetic",
  env: { OPENCLAW_TRAJECTORY: "1" },
});
assert(recorder);
const pluginCount = 40;
const toolCount = 60;
const registry = createEmptyPluginRegistry();
registry.plugins.push(
  ...Array.from({ length: pluginCount }, (_, index) =>
    createPluginRecord({
      id: `synthetic-plugin-${index}`,
      source: `/synthetic/plugins/plugin-${index}/index.ts`,
      toolNames: [`synthetic_tool_${index}`],
    }),
  ),
);
setActivePluginRegistry(registry, "synthetic-trajectory-benchmark");
const env = {
  HOME: "/synthetic/home",
  OPENCLAW_STATE_DIR: "/synthetic/home/.openclaw",
  GIT_COMMIT: "abcdef0123456789",
};
process.argv = ["node", "/synthetic/home/trajectory-benchmark.js"];

function config(revision: number): OpenClawConfig {
  const source: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `synthetic-agent-${index}`,
          {
            name: `Synthetic agent ${index}, revision ${revision}`,
            workspace: `/synthetic/workspaces/agent-${index}`,
          },
        ]),
      ),
    },
    plugins: {
      entries: Object.fromEntries(
        Array.from({ length: pluginCount }, (_, index) => [
          `synthetic-plugin-${index}`,
          {
            enabled: true,
            config: {
              apiKey: `synthetic-secret-${revision}-${index}`,
              baseUrl: `https://plugin-${index}.example.invalid/v1`,
              description: `Synthetic plugin ${index}: ${"fixture configuration ".repeat(16)}`,
              routing: { tags: ["team", "tools", "mock"], revision, maxConcurrent: 8 },
              profiles: Array.from({ length: 4 }, (_profile, profile) => ({
                name: `profile-${profile}`,
                token: `synthetic-token-${index}-${profile}`,
                scope: `synthetic-scope-${profile}`,
              })),
            },
          },
        ]),
      ),
    },
  };
  return captureRuntimeConfigWithSource(source, source);
}

function tools(revision: number) {
  return Array.from({ length: toolCount }, (_, index) => ({
    name: `synthetic_tool_${String(index).padStart(3, "0")}`,
    description: `Synthetic tool ${index}, revision ${revision}`,
    parameters: publishRuntimeToolInputSchema({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_field, field) => [
          `field_${field}`,
          {
            type: "string",
            description: `Synthetic field ${field} for tool ${index}, revision ${revision}`,
            enum: ["first", "second", "third"],
          },
        ]),
      ),
      required: ["field_0"],
      additionalProperties: false,
    }).schema,
  }));
}

const configs = [config(1), config(2)];
const catalogs = [tools(1), tools(2)] as const;
const skillsSnapshot = {
  prompt: "Synthetic skill catalog. ".repeat(100),
  version: 1,
  skills: Array.from({ length: 10 }, (_, index) => ({ name: `skill-${index}` })),
};
const metadata = (index: number) =>
  buildTrajectoryRunMetadata({
    env,
    config: configs[index % configs.length],
    skillsSnapshot,
    workspaceDir: "/synthetic/workspace",
    sessionKey: "agent:synthetic:benchmark",
    provider: "synthetic",
    modelId: "mock",
    timeoutMs: 30_000,
  });
const toolDefinitions = (index: number) =>
  toTrajectoryToolDefinitions(catalogs[index % 2 === 0 ? 0 : 1]);
const golden = [0, 1, 0].map((index) => ({
  metadata: { ...metadata(index), capturedAt: "<timestamp>" },
  tools: toolDefinitions(index),
}));
const captureMetadata = (index: number) => {
  recorder.recordEvent("trace.metadata", metadata(index));
  return sink.readLine();
};
const persisted = [0, 1, 0].map((index) => {
  const event = JSON.parse(captureMetadata(index));
  event.ts = "<timestamp>";
  event.seq = event.sourceSeq = 1;
  event.data.capturedAt = "<timestamp>";
  return JSON.stringify(event);
});
assert.equal(persisted[0], persisted[2]);
assert.notEqual(persisted[0], persisted[1]);
const goldenJson = JSON.stringify(golden);
assert(!goldenJson.includes("synthetic-secret-"), "Config credential redaction failed");
assert(!goldenJson.includes("synthetic-token-"), "Nested credential redaction failed");
assert.notDeepEqual(golden[0], golden[1], "Replacement identities must capture changed facts");
assert.deepEqual(golden[0], golden[2], "Interleaved identities must retain their own facts");

const scenarios = [];
for (const [name, capture] of [
  ["metadata-40-plugins", metadata],
  ["session-start-metadata-capture", captureMetadata],
  ["tool-definitions-60-tools", toolDefinitions],
] as const) {
  for (let warmup = 0; warmup < 100; warmup++) {
    capture(warmup);
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  const collections: Array<{ kind: number; start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const event of list.getEntries()) {
      const detail = (event as import("node:perf_hooks").PerformanceNodeEntry).detail;
      collections.push({ kind: detail.kind, start: event.startTime, duration: event.duration });
    }
  });
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 8192);
  }
  observer.observe({ entryTypes: ["gc"] });
  const memoryBefore = process.memoryUsage();
  const loadBefore = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  let last: unknown;
  for (let index = 0; index < iterations; index++) {
    last = capture(index);
  }
  const end = performance.now();
  const elapsedCpu = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const loadAfter = loadavg();
  assert(last);
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let allocation;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    allocation = {
      sampledBytes: bytes,
      bytesPerAttempt: bytes / iterations,
      samples: profile.samples.length,
      samplingInterval: 8192,
      includesCollectedObjects: true,
    };
    inspector.disconnect();
  }
  const measuredGc = collections.filter((event) => event.start >= start && event.start < end);
  scenarios.push({
    name,
    iterations,
    mainCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
    mainCpuMsPerAttempt: (elapsedCpu.user + elapsedCpu.system) / 1000 / iterations,
    wallMs: end - start,
    allocation,
    gc: [...new Set(measuredGc.map((event) => event.kind))].map((kind) => {
      const pauses = measuredGc
        .filter((event) => event.kind === kind)
        .map((event) => event.duration);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((sum, duration) => sum + duration, 0),
        maxMs: Math.max(...pauses),
      };
    }),
    memoryBefore,
    memoryAfter,
    loadBefore,
    loadAfter,
  });
}
const sourceRoot =
  process.env.OPENCLAW_BENCH_BASELINE_DIR ?? fileURLToPath(new URL("../../", import.meta.url));
console.log(
  JSON.stringify({
    mode: values.mode,
    node: process.version,
    fixture: {
      plugins: pluginCount,
      tools: toolCount,
      interleavedRevisions: configs.length,
      configBytes: Buffer.byteLength(JSON.stringify(configs[0])),
      toolBytes: Buffer.byteLength(JSON.stringify(catalogs[0])),
    },
    sourceHashes: Object.fromEntries(
      ["metadata", "runtime"].map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(sourceRoot, `src/trajectory/${name}.ts`)))
          .digest("hex"),
      ]),
    ),
    outputHash: createHash("sha256").update(goldenJson).digest("hex"),
    persistedHash: createHash("sha256").update(JSON.stringify(persisted)).digest("hex"),
    persistedBytes: persisted.map((line) => Buffer.byteLength(line)),
    scenarios,
  }),
);
