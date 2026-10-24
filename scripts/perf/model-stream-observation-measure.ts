import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { mock } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { StreamFn } from "../../src/agents/runtime/index.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../src/infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../src/infra/diagnostic-trace-context.js";
import { getModelTransportContext } from "../../src/llm/model-transport-context.js";
import type { AssistantMessage, AssistantMessageEvent } from "../../src/llm/types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "1000" },
    chunks: { type: "string", default: "100" },
    mode: { type: "string", default: "timing" },
    listeners: { type: "string", default: "none" },
    raw: { type: "boolean", default: false },
    owner: { type: "string" },
    output: { type: "string" },
    "start-file": { type: "string" },
  },
});
assert(["timing", "allocation", "count"].includes(values.mode), "invalid --mode");
assert(["none", "metrics", "full"].includes(values.listeners), "invalid --listeners");
assert(values.output, "--output is required");
const integer = (name: "turns" | "chunks") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, fallback: 1, min: 1 });
const turns = integer("turns");
const chunks = integer("chunks");
const output = path.resolve(values.output);
await mkdir(path.dirname(output), { recursive: true });
const {
  wrapStreamFnWithDiagnosticModelCallEvents,
}: typeof import("../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js") =
  await import(
    values.owner
      ? pathToFileURL(path.resolve(values.owner)).href
      : "../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js"
  );
const counts = { jsonStringify: 0, usageReads: 0, providerNext: 0, providerResults: 0 };
let counting = false;
const usage: AssistantMessage["usage"] = {
  input: 10,
  output: chunks,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10 + chunks,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message: AssistantMessage = {
  role: "assistant",
  api: "openai-responses",
  provider: "synthetic",
  model: "synthetic",
  timestamp: 1,
  stopReason: "stop",
  content: [{ type: "text", text: "x".repeat(chunks) }],
  get usage() {
    if (counting) {
      counts.usageReads++;
    }
    return usage;
  },
};
const events: AssistantMessageEvent[] = [
  ...Array.from({ length: chunks }, (): AssistantMessageEvent => ({
    type: "text_delta",
    contentIndex: 0,
    delta: "x",
  })),
  { type: "done", reason: "stop", message },
];
const expectedBytes = chunks + Buffer.byteLength(JSON.stringify(events.at(-1)), "utf8");
const context: Parameters<StreamFn>[1] = {
  systemPrompt: "Synthetic instructions",
  messages: [{ role: "user", content: "Synthetic prompt. ".repeat(512), timestamp: 1 }],
  tools: [],
};
const model: Parameters<StreamFn>[0] = {
  id: "synthetic",
  name: "Synthetic",
  provider: "synthetic",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
let identityProbe:
  | Array<{ expected: string | undefined; observed: string | undefined }>
  | undefined;
const source: StreamFn = (_model, _context, options) => ({
  [Symbol.asyncIterator]() {
    let index = 0;
    return {
      async next() {
        if (counting) {
          counts.providerNext++;
        }
        if (identityProbe) {
          await Promise.resolve();
          identityProbe.push({
            expected: options?.requestId,
            observed: getModelTransportContext()?.requestId,
          });
        }
        return index < events.length
          ? { done: false as const, value: events[index++]! }
          : { done: true as const, value: undefined };
      },
      async return() {
        index = events.length;
        return { done: true as const, value: undefined };
      },
    };
  },
  async result() {
    if (counting) {
      counts.providerResults++;
    }
    return message;
  },
});
let sequence = 0;
const wrapped = values.raw
  ? source
  : wrapStreamFnWithDiagnosticModelCallEvents(source, {
      runId: "synthetic-stream-run",
      sessionKey: "agent:synthetic:stream",
      provider: "synthetic",
      model: "synthetic",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => `synthetic-call-${++sequence}`,
      suppressPluginHooks: true,
    });
setDiagnosticsEnabledForProcess(true);
let completed = 0;
let invalidMetrics = 0;
let checkingMetrics = false;
const unsubscribe =
  values.listeners === "none"
    ? undefined
    : onInternalDiagnosticEvent(
        (event) => {
          if (!checkingMetrics || event.type !== "model.call.completed") {
            return;
          }
          completed++;
          if (
            event.responseStreamBytes !== expectedBytes ||
            event.usage?.input !== 10 ||
            event.usage?.output !== chunks ||
            event.usage?.promptTokens !== 10
          ) {
            invalidMetrics++;
          }
        },
        {
          include: ["model.call.completed", "model.call.error"],
          includePromptStats: values.listeners === "full",
        },
      );
// Probe consecutive resumptions from interleaved callers; creating a generator in a
// transport context alone does not establish the identity on its later next().
identityProbe = [];
const probes = await Promise.all([wrapped(model, context), wrapped(model, context)]);
const iterators = probes.map((stream) => stream[Symbol.asyncIterator]());
for (let index = 0; index < 3; index++) {
  for (const iterator of iterators) {
    await iterator.next();
  }
}
for (const iterator of iterators) {
  await iterator.return?.();
}
assert.equal(identityProbe.length, 6);
assert(identityProbe.every(({ expected, observed }) => expected === observed));
if (!values.raw) {
  assert.equal(new Set(identityProbe.map(({ observed }) => observed)).size, 2);
}
identityProbe = undefined;
assert.equal(getModelTransportContext(), undefined);
async function turn(verify = false) {
  for (let request = 0; request < 2; request++) {
    const stream = await wrapped(model, context);
    let received = 0;
    for await (const event of stream) {
      if (verify) {
        assert.equal(event, events[received]);
      }
      received++;
    }
    const result = await stream.result();
    if (verify) {
      assert.equal(received, chunks + 1);
      assert.equal(result, message);
    }
  }
}
await turn(true);
for (let index = 0; index < 20; index++) {
  await turn();
}
await waitForDiagnosticEventsDrained();
await nextTurn();
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
const pauses: Record<string, number[]> = {};
const turnLatencies: number[] = [];
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const kind = String(
      (entry as import("node:perf_hooks").PerformanceEntry & { detail: { kind: number } }).detail
        .kind,
    );
    (pauses[kind] ??= []).push(entry.duration);
  }
});
const loop = monitorEventLoopDelay({ resolution: 1 });
const inspector = new Session();
let restoreCounting: (() => void) | undefined;
if (values.mode === "timing") {
  gc.observe({ entryTypes: ["gc"] });
  loop.enable();
} else if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
} else {
  const nativeStringify = JSON.stringify;
  const instrument = mock.method(JSON, "stringify", (...args: unknown[]) => {
    counts.jsonStringify++;
    return Reflect.apply(nativeStringify, JSON, args);
  });
  restoreCounting = () => instrument.mock.restore();
  counting = true;
}
checkingMetrics = true;
const cpu = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < turns; index++) {
  const turnStarted = values.mode === "timing" ? performance.now() : 0;
  await turn();
  if (values.mode === "timing") {
    turnLatencies.push(performance.now() - turnStarted);
  }
  if (index % 10 === 9) {
    await waitForDiagnosticEventsDrained();
    await nextTurn();
  }
}
await waitForDiagnosticEventsDrained();
const elapsedMs = performance.now() - started;
const used = process.cpuUsage(cpu);
checkingMetrics = false;
counting = false;
restoreCounting?.();
await nextTurn();
gc.disconnect();
loop.disable();
assert.equal(invalidMetrics, 0, "completed-event sizes or usage changed");
assert.equal(completed, !values.raw && values.listeners !== "none" ? turns * 2 : 0);
assert.equal(getModelTransportContext(), undefined);
let allocation: { sampledBytes: number; samples: number; profilePath: string } | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  const profilePath = `${output}.heapprofile`;
  await writeFile(profilePath, JSON.stringify(profile));
  allocation = { sampledBytes: sum(profile.head), samples: profile.samples.length, profilePath };
}
const tail = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    p99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
  };
};
const report = {
  node: process.version,
  mode: values.mode,
  listeners: values.listeners,
  raw: values.raw,
  owner: values.owner ?? "current source",
  turns,
  requests: turns * 2,
  chunksPerRequest: chunks,
  completed,
  expectedResponseBytesPerRequest: expectedBytes,
  ...(values.mode === "timing"
    ? {
        elapsedMs,
        cpuMsPerTurn: (used.user + used.system) / 1000 / turns,
        turnLatency: tail(turnLatencies),
        gcMsPerTurn:
          Object.values(pauses)
            .flat()
            .reduce((sum, ms) => sum + ms, 0) / turns,
        gc: Object.fromEntries(
          Object.entries(pauses).map(([kind, samples]) => [kind, tail(samples)]),
        ),
        loop: {
          count: loop.count,
          p95Ms: loop.percentile(95) / 1e6,
          p99Ms: loop.percentile(99) / 1e6,
          maxMs: loop.max / 1e6,
        },
      }
    : {}),
  ...(allocation
    ? { allocation: { ...allocation, bytesPerTurn: allocation.sampledBytes / turns } }
    : {}),
  ...(values.mode === "count"
    ? { counts, usageReadScope: "includes terminal JSON sizing and terminal/result observation" }
    : {}),
};
unsubscribe?.();
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
