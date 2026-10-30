/**
 * Owner-only synthetic recordEvent measurement; no Gateway or database writes.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/trajectory-record-event-measure.ts
 *   --mode timing --iterations 2000
 * Repeat with --mode allocation, alternating five base/candidate process samples.
 * Baseline: OPENCLAW_BENCH_BASELINE_DIR=/absolute/source-overlay plus
 * --import ./scripts/perf/worker-retained-heap-preload.ts after the TSX preload.
 * The sink alone is replaced; runtime limiting, projection and serialization are real.
 * Compare outputHash before metrics. Acceptance: unchanged captured bytes, zero
 * omitted-replay reads, reduced allocation/CPU. Untraced timing owns CPU/GC evidence.
 * Five event payloads cover attempt context (60 messages/40 tools), startup metadata
 * (40 plugins/10 skills), session start, tool call and tool result. Inputs are frozen
 * outside measurement; payload builders and sink persistence are excluded. Ordinary
 * subscribed tools and nested tool lifecycles use the same call/result record owner.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
assert(global.gc, "Use --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "--iterations",
});
assert(iterations <= 100000);
const sinkUrl = `data:text/javascript,${encodeURIComponent(`
let lastLine;
export const readLine = () => lastLine;
export const createSqliteTrajectoryRuntimeSink = async () => ({
  write: (_event, line) => { lastLine = line; },
  flush: async () => {},
  describeFlushState: () => undefined,
});`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith("/runtime-store-writer.js") ||
      specifier === "./runtime-store-writer.js"
      ? { url: sinkUrl, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const sink: { readLine(): string } = await import(sinkUrl);
const { createTrajectoryRuntimeRecorder } = await import("../../src/trajectory/runtime.js");
hook.deregister();
const recorder = await createTrajectoryRuntimeRecorder({
  sessionId: "synthetic",
  env: { OPENCLAW_TRAJECTORY: "1" },
});
assert(recorder);
const replay = {
  v: 1,
  type: "anthropic-compaction",
  data: "synthetic opaque state ".repeat(2000),
  provider: "synthetic",
  api: "synthetic",
  model: "mock",
  sessionHash: "synthetic",
};
const messages = Array.from({ length: 60 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  ...(index % 2 ? { providerReplay: replay } : {}),
  content: [{ type: "text", text: `Message ${index}. ${"Synthetic context. ".repeat(16)}` }],
}));
const context = {
  systemPrompt: "Synthetic system instruction. ".repeat(100),
  messages,
  tools: Array.from({ length: 40 }, (_, index) => ({
    name: `tool_${index}`,
    parameters: { type: "object", properties: { query: { type: "string" } } },
  })),
  prompt: "Inspect the synthetic workspace",
  imagesCount: 0,
  streamStrategy: "default",
  transport: "sse",
  transcriptLeafId: "synthetic-leaf",
};
const started = {
  trigger: "user",
  sessionFile: "/synthetic/session",
  workspaceDir: "/synthetic/workspace",
  agentId: "main",
  messageProvider: "webchat",
  messageChannel: "webchat",
  localModelLean: false,
  toolCount: 40,
  clientToolCount: 0,
};
const metadata = {
  capturedAt: "2026-10-28T00:00:00.000Z",
  harness: {
    type: "openclaw",
    name: "OpenClaw",
    version: "synthetic",
    gitSha: "synthetic",
    os: { platform: "darwin", arch: "arm64", release: "synthetic", label: "synthetic" },
    runtime: { node: process.version },
    invocation: ["node", "openclaw"],
    entrypoint: "<workspace>/openclaw",
    workspaceDir: "<workspace>",
    sessionFile: "<state>/session",
  },
  model: {
    provider: "synthetic",
    name: "mock",
    api: "synthetic",
    fastMode: false,
    thinkLevel: "medium",
    reasoningLevel: "off",
  },
  config: {
    redacted: {
      agents: { defaults: { model: "synthetic/mock" } },
      plugins: {
        entries: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`plugin_${i}`, { enabled: true }]),
        ),
      },
    },
    runtime: {
      timeoutMs: 600000,
      trigger: "user",
      disableTools: false,
      toolResultFormat: "markdown",
    },
  },
  plugins: {
    source: "active-registry",
    importedRuntimePluginIds: Array.from({ length: 40 }, (_, i) => `plugin_${i}`),
    entries: Array.from({ length: 40 }, (_, i) => ({
      id: `plugin_${i}`,
      name: `Synthetic plugin ${i}`,
      version: "1.0.0",
      description: "Synthetic plugin description",
      origin: "bundled",
      enabled: true,
      explicitlyEnabled: true,
      activated: true,
      imported: true,
      activationSource: "config",
      activationReason: "enabled",
      status: "loaded",
      format: "openclaw",
      kind: "tool",
      source: `/synthetic/plugins/plugin_${i}/index.ts`,
      rootDir: `/synthetic/plugins/plugin_${i}`,
      workspaceDir: "/synthetic/workspace",
      toolNames: [`tool_${i}`],
      hookNames: [],
      channelIds: [],
      cliBackendIds: [],
      providerIds: [],
    })),
  },
  skills: {
    snapshotVersion: 1,
    entries: Array.from({ length: 10 }, (_, i) => ({
      id: `skill_${i}`,
      name: `skill_${i}`,
      description: "Synthetic skill",
      filePath: `<workspace>/skill_${i}/SKILL.md`,
      baseDir: `<workspace>/skill_${i}`,
      source: "bundled",
      available: true,
    })),
  },
  prompting: {
    skillsPrompt: "Synthetic skill catalog. ".repeat(100),
    userPromptPrefixText: "Synthetic prefix",
    systemPromptReport: {
      source: "run",
      workspaceDir: "<workspace>",
      systemPrompt: { chars: 3000, projectContextChars: 1000, nonProjectContextChars: 2000 },
    },
  },
  redaction: {
    config: { mode: "redactConfigObject", secretsMasked: true },
    payloads: {
      mode: "sanitizeDiagnosticPayload",
      credentialsRemoved: true,
      imageDataRedacted: true,
    },
    harness: {
      mode: "diagnostic-support-redaction",
      programArgumentsRedacted: true,
      localPathsRedacted: true,
    },
  },
  metadata: {
    sessionKey: "synthetic:main",
    agentId: "main",
    messageProvider: "webchat",
    messageChannel: "webchat",
  },
};
const call = { name: "synthetic_tool", toolCallId: "call-1", args: { query: "inspect" } };
const result = {
  name: "synthetic_tool",
  toolCallId: "call-1",
  success: true,
  result: { content: [{ type: "text", text: "Synthetic result. ".repeat(64) }] },
};
const fixtureInputs = freezeJsonSnapshot([context, started, metadata, call, result]);
const serializedInputs = JSON.stringify(fixtureInputs);
const golden = [];
const scenarios = [];
for (const [name, capture] of [
  ["attempt-context", () => recorder.recordEvent("context.compiled", context)],
  ["session-started", () => recorder.recordEvent("session.started", started)],
  ["trace-metadata", () => recorder.recordEvent("trace.metadata", metadata)],
  ["tool-call", () => recorder.recordEvent("tool.call", call)],
  ["tool-result", () => recorder.recordEvent("tool.result", result)],
] as const) {
  capture();
  const captured = JSON.parse(sink.readLine());
  delete captured.ts;
  delete captured.seq;
  delete captured.sourceSeq;
  assert(!JSON.stringify(captured).includes("providerReplay"));
  golden.push(captured);
  for (let index = 0; index < 100; index++) {
    capture();
  }
  global.gc();
  await nextTurn();
  const inspector = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 8192);
  }
  const collections: Array<{ kind: number; start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const event of list.getEntries()) {
      const detail = (event as import("node:perf_hooks").PerformanceNodeEntry).detail;
      collections.push({ kind: detail.kind, start: event.startTime, duration: event.duration });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    capture();
  }
  const end = performance.now();
  const elapsedCpu = process.threadCpuUsage(cpu);
  const after = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let allocation;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocation = {
      bytesPerOperation: profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
      samples: profile.samples.length,
    };
    inspector.disconnect();
  }
  const gc = collections.filter((event) => event.start >= start && event.start < end);
  scenarios.push({
    name,
    iterations,
    serializedBytes: Buffer.byteLength(sink.readLine()),
    cpuUsPerOperation: (elapsedCpu.user + elapsedCpu.system) / iterations,
    wallMs: end - start,
    allocation,
    gc: [...new Set(gc.map((event) => event.kind))].map((kind) => {
      const pauses = gc.filter((event) => event.kind === kind).map((event) => event.duration);
      return {
        kind,
        count: pauses.length,
        totalMs: pauses.reduce((a, b) => a + b, 0),
        maxMs: Math.max(...pauses),
      };
    }),
    hostLoad,
    before,
    after,
  });
}
assert.equal(JSON.stringify(fixtureInputs), serializedInputs, "Capture mutated caller input");
console.log(
  JSON.stringify({
    mode: values.mode,
    node: process.version,
    outputHash: createHash("sha256").update(JSON.stringify(golden)).digest("hex"),
    scenarios,
  }),
);
