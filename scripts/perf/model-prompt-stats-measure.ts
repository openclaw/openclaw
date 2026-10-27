// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-prompt-stats-measure.ts
// Use --ownership mutable|content|message and --owner <baseline-module> for paired
// allocation runs; --mode timing keeps GC and event-loop measurements untraced.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { mock } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeTranscriptJsonValue } from "../../src/config/sessions/transcript-json.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    calls: { type: "string", default: "1000" },
    messages: { type: "string", default: "500" },
    ownership: { type: "string", default: "mutable" },
    mode: { type: "string", default: "profile" },
    owner: { type: "string" },
    lifecycle: { type: "string" },
    "start-file": { type: "string" },
  },
});
const {
  createModelPromptStats,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js") =
  await import(
    values.owner
      ? pathToFileURL(values.owner).href
      : "../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js"
  );
const integer = (name: keyof typeof values) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const calls = integer("calls");
if (!["mutable", "content", "message"].includes(values.ownership)) {
  throw new Error("--ownership must be mutable, content or message");
}
if (!["profile", "timing"].includes(values.mode)) {
  throw new Error(
    "--mode must be profile or timing (use a separate --trace-gc-nvp timing pass for promotion)",
  );
}
const messages = Array.from({ length: integer("messages") }, (_, index) => {
  const message = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `${index}: ${'Quoted "text", café 🦞, lone \ud800 and newline\n'.repeat(200)}`,
      },
    ],
    timestamp: index,
  };
  if (values.ownership === "content") {
    normalizeTranscriptJsonValue(message, "");
  } else if (values.ownership === "message") {
    normalizeTranscriptJsonValue({ message }, "");
  }
  return message;
});
const context = { messages, systemPrompt: "Synthetic instructions", tools: [] };
const expected = {
  inputMessagesCount: messages.length,
  inputMessagesChars: JSON.stringify(messages).length,
  systemPromptChars: context.systemPrompt.length,
  toolDefinitionsCount: 0,
  toolDefinitionsChars: 2,
  totalChars: JSON.stringify(messages).length + context.systemPrompt.length + 2,
};
let measure = createModelPromptStats();
let drain = async () => {};
if (values.lifecycle) {
  const {
    createModelLifecycle,
  }: typeof import("../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-lifecycle.js") =
    await import(pathToFileURL(values.lifecycle).href);
  const { createModelObserver } =
    await import("../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-observation.js");
  const { startDiagnosticRunActivityTracking } =
    await import("../../src/logging/diagnostic-run-activity.js");
  const { startDiagnosticStabilityRecorder } =
    await import("../../src/logging/diagnostic-stability.js");
  const { waitForDiagnosticEventsDrained } = await import("../../src/infra/diagnostic-events.js");
  const { createDiagnosticTraceContext } =
    await import("../../src/infra/diagnostic-trace-context.js");
  startDiagnosticRunActivityTracking();
  startDiagnosticStabilityRecorder();
  drain = waitForDiagnosticEventsDrained;
  let sequence = 0;
  const trace = createDiagnosticTraceContext();
  measure = (streamContext) => {
    const callId = `synthetic-${sequence++}`;
    const lifecycle = createModelLifecycle({
      ctx: {
        runId: callId,
        provider: "synthetic",
        model: "synthetic-model",
        trace,
        nextCallId: () => callId,
        suppressPluginHooks: true,
      },
      options: undefined,
      createObserver: (capturePromptStats: boolean, captureByteStats: boolean) =>
        createModelObserver({
          streamContext,
          capturePromptStats,
          captureByteStats,
          suppressPluginHooks: true,
        }),
    });
    lifecycle.emitCompleted();
    return lifecycle.observer.promptStats;
  };
}
function verifyStats(stats: ReturnType<typeof measure>) {
  // Default listeners need lifecycle facts, not prompt sizes. Baseline still produces them.
  if (stats !== undefined || !values.lifecycle) {
    assert.deepEqual(stats, expected);
  }
}
const coldCpu = process.cpuUsage();
const coldStart = performance.now();
const coldStats = measure(context);
const coldMs = performance.now() - coldStart;
const coldUsed = process.cpuUsage(coldCpu);
verifyStats(coldStats);
verifyStats(measure(context));

// Count payload traversal independently of timing and allocation instrumentation.
let payloadVisits = 0;
const nativeStringify = JSON.stringify;
const stringify = mock.method(JSON, "stringify", (value: unknown, replacer: unknown) => {
  if (typeof replacer !== "function") {
    return nativeStringify(value);
  }
  return nativeStringify(value, function (key, part: unknown) {
    if (key === "text") {
      payloadVisits++;
    }
    return Reflect.apply(replacer as (...args: unknown[]) => unknown, this, [key, part]);
  });
});
try {
  measure(context);
} finally {
  stringify.mock.restore();
}

// Count record creation separately so instrumentation is outside the profiles.
const records = new WeakSet<object>();
// oxlint-disable-next-line typescript/unbound-method -- The probe forwards the original receiver.
const originalSet = WeakMap.prototype.set;
let newRecords = 0;
const set = mock.method(
  WeakMap.prototype,
  "set",
  function (this: WeakMap<object, unknown>, key: object, value: unknown) {
    if (typeof value === "object" && value !== null && "text" in value && "chars" in value) {
      if (!records.has(value)) {
        newRecords++;
        records.add(value);
      }
    }
    return originalSet.call(this, key, value);
  },
);
let warmRecords: number;
try {
  verifyStats(measure(context));
  newRecords = 0;
  verifyStats(measure(context));
  warmRecords = newRecords;
} finally {
  set.mock.restore();
}
for (let index = 0; index < 50; index++) {
  measure(context);
}
await drain();
console.log("WARM_READY");
if (values["start-file"]) {
  let startAt = 0;
  while (!startAt) {
    startAt = Number(await readFile(values["start-file"], "utf8").catch(() => "0"));
    if (!startAt) {
      await delay(20);
    }
  }
  assert(startAt > Date.now(), "missed synchronized start");
  await delay(startAt - Date.now());
}
if (values.mode === "timing") {
  const pauses: Record<string, number[]> = {};
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = String(
        (
          entry as import("node:perf_hooks").PerformanceEntry & {
            detail: { kind: number };
          }
        ).detail.kind,
      );
      (pauses[kind] ??= []).push(entry.duration);
    }
  });
  gc.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  console.log("TIMING_START");
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < calls; index++) {
    measure(context);
    if (index % 10 === 9) {
      await drain();
      await nextTurn();
    }
  }
  await drain();
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await nextTurn();
  gc.disconnect();
  loop.disable();
  console.log("TIMING_END");
  console.log(
    JSON.stringify({
      node: process.version,
      calls,
      messages: messages.length,
      ownership: values.ownership,
      promptChars: expected.totalChars,
      payloadVisitsPerWarmCall: payloadVisits,
      coldMs,
      coldCpuMs: (coldUsed.user + coldUsed.system) / 1000,
      naturalGc: Object.fromEntries(
        Object.entries(pauses).map(([kind, samples]) => [
          kind,
          {
            count: samples.length,
            msPerCall: samples.reduce((sum, ms) => sum + ms, 0) / calls,
            maxMs: Math.max(...samples),
            p95Ms: samples.toSorted((a, b) => a - b)[Math.floor(samples.length * 0.95)],
            p99Ms: samples.toSorted((a, b) => a - b)[Math.floor(samples.length * 0.99)],
          },
        ]),
      ),
      loop: {
        count: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
      cpuMsPerCall: (used.user + used.system) / 1000 / calls,
      msPerCall: elapsedMs / calls,
    }),
  );
  process.exit(0);
}
if (!global.gc) {
  throw new Error("Run with --expose-gc");
}
const inspector = new Session();
inspector.connect();
function ownerBytes(node: HeapProfiler.SamplingHeapProfileNode, owned = false): number {
  // V8 can inline jsonLength into the prompt-stat owner after warmup.
  const underOwner =
    owned ||
    node.callFrame.functionName === "jsonLength" ||
    node.callFrame.functionName === "streamContextModelPromptStats";
  return (
    (underOwner ? node.selfSize : 0) +
    node.children.reduce((sum, child) => sum + ownerBytes(child, underOwner), 0)
  );
}
async function profile(includeCollected: boolean) {
  global.gc!();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: values.lifecycle ? 16384 : 512,
    includeObjectsCollectedByMajorGC: includeCollected,
    includeObjectsCollectedByMinorGC: includeCollected,
  });
  console.log(`PROFILE_START ${includeCollected ? "allocation" : "retained"}`);
  const start = performance.now();
  for (let index = 0; index < calls; index++) {
    measure(context);
    if (index % 100 === 99) {
      await drain();
      await nextTurn();
    }
  }
  await drain();
  const elapsedMs = performance.now() - start;
  console.log("PROFILE_END");
  if (!includeCollected) {
    await nextTurn();
    global.gc!();
  }
  const { profile: result } = await inspector.post("HeapProfiler.stopSampling");
  return { bytesPerCall: ownerBytes(result.head, Boolean(values.lifecycle)) / calls, elapsedMs };
}
const allocation = await profile(true);
const retainedChurn = await profile(false);
inspector.disconnect();
verifyStats(measure(context));
console.log(
  JSON.stringify({
    node: process.version,
    calls,
    messages: messages.length,
    ownership: values.ownership,
    promptChars: expected.totalChars,
    newRecordsPerWarmCall: warmRecords,
    payloadVisitsPerWarmCall: payloadVisits,
    allocatedBytesPerCall: allocation.bytesPerCall,
    retainedChurnBytesPerCall: retainedChurn.bytesPerCall,
    profiledMsPerCall: allocation.elapsedMs / calls,
  }),
);
