// Owner-only synthetic probe; run on the approved benchmark host, never a production Gateway.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { publishRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { SessionEntry } from "../../src/agents/sessions/session-manager-types.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    case: { type: "string", default: "warm" },
    calls: { type: "string", default: "2000" },
    "start-at": { type: "string" },
    output: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
const calls = parseStrictIntegerOption({
  raw: values.calls,
  label: "calls",
  min: 1000,
  fallback: 2000,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "start-at",
  min: 1,
  fallback: 0,
});
assert.ok(["warm", "restored", "guidance"].includes(values.case), "Unknown --case");
assert.ok(values.output, "--output is required");
assert.ok(globalThis.gc, "Run with --expose-gc");
const owner = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/agents/embedded-agent-runner/session-prompt-state.ts", import.meta.url);
const runtime: typeof import("../../src/agents/embedded-agent-runner/session-prompt-state.js") =
  await import(owner.href);
const tools: AnyAgentTool[] = Array.from({ length: 50 }, (_, index) => {
  const projection = publishRuntimeToolInputSchema({
    type: "object",
    properties: {
      filters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 20 }, (_unused, field) => [
            `field_${field}`,
            {
              type: "string",
              description: `Synthetic collection ${index} filter ${field}.`,
              enum: ["exact", "prefix", "contains"],
            },
          ]),
        ),
        additionalProperties: false,
      },
    },
    required: ["filters"],
    additionalProperties: false,
  });
  assert.equal(projection.violations.length, 0);
  assert.ok(isRecord(projection.schema));
  return {
    name: `fixture_${index}`,
    label: `Fixture ${index}`,
    description: `Search collection ${index}. Use fixture_0 for related records.`,
    parameters: projection.schema,
    execute: async () => ({ content: [], details: { executor: "initial" } }),
  };
});
let lease = runtime.retainEmbeddedSessionPromptState("surface-benchmark");
const entries: SessionEntry[] = [];
let checkpoints = 0;
const append = async (customType: string, data: unknown) => {
  checkpoints++;
  entries.push({
    type: "custom",
    customType,
    data: structuredClone(data),
    id: "fixture-pin",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
  });
};
const parameters = { routeKey: "synthetic-route", toolPolicy: "synthetic-policy", entries };
runtime.prepareSessionToolSurface({ ...parameters, state: lease.state, tools });
await runtime.persistSessionToolSurface(lease.state, append);
if (values.case !== "warm") {
  lease[Symbol.dispose]();
  lease = runtime.retainEmbeddedSessionPromptState("surface-benchmark");
}
const current = tools.map((tool) => ({
  ...tool,
  description: values.case === "guidance" ? `Search collection ${tool.name}.` : tool.description,
  execute: async () => ({ content: [], details: { executor: "current" } }),
}));
const run = () =>
  runtime.prepareSessionToolSurface({ ...parameters, state: lease.state, tools: current });
async function verify() {
  const result = run();
  assert.deepEqual(
    result.map((tool) => [tool.name, tool.description, tool.parameters]),
    tools.map((tool) => [tool.name, tool.description, tool.parameters]),
  );
  for (const tool of result) {
    assert.deepEqual((await tool.execute("fixture-call", {})).details, { executor: "current" });
  }
  assert.equal(lease.state.pendingToolSurface, undefined);
  await runtime.persistSessionToolSurface(lease.state, append);
  assert.equal(checkpoints, 1, "An unchanged pin must not append another checkpoint");
}
await verify();
for (let index = 0; index < 100; index++) {
  run();
}
globalThis.gc();
await delay(20);
async function waitForStart() {
  if (startAt) {
    assert.ok(startAt > Date.now(), "Missed --start-at; discard and repeat the pair");
    await delay(startAt - Date.now());
  }
}
function distribution(input: number[]) {
  const sorted = input.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
async function workload(latencies?: number[]) {
  for (let index = 0; index < calls; index++) {
    const start = latencies ? performance.now() : 0;
    run();
    if (latencies) {
      latencies.push(performance.now() - start);
    }
    if (index % 10 === 9) {
      await delay(1);
    }
  }
}
async function measure() {
  const gc: Array<{ start: number; ms: number; kind: number }> = [];
  const record = (observations: PerformanceEntry[]) => {
    for (const entry of observations) {
      const { kind } = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      gc.push({ start: entry.startTime, ms: entry.duration, kind });
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  await delay(10);
  await waitForStart();
  lag.reset();
  observer.observe({ entryTypes: ["gc"] });
  console.log("MEASURE_START");
  const rssBefore = process.memoryUsage().rss;
  const cpu = process.cpuUsage();
  const startedAt = Date.now();
  const start = performance.now();
  const latencies: number[] = [];
  await workload(latencies);
  const end = performance.now();
  const used = process.cpuUsage(cpu);
  const rssAfter = process.memoryUsage().rss;
  lag.disable();
  console.log("MEASURE_END");
  await delay(10);
  record(observer.takeRecords());
  observer.disconnect();
  const selected = gc.filter((entry) => entry.start >= start && entry.start <= end);
  const pauses = (kind?: number) => {
    const times = selected
      .filter((entry) => kind === undefined || entry.kind === kind)
      .map((entry) => entry.ms);
    return { ...distribution(times), totalMs: times.reduce((sum, value) => sum + value, 0) };
  };
  return {
    startedAt,
    wallMs: end - start,
    cpuMs: (used.user + used.system) / 1000,
    latencyMs: distribution(latencies),
    rssBefore,
    rssAfter,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    eventLoopMs: {
      count: lag.count,
      p95: lag.count ? lag.percentile(95) / 1e6 : null,
      p99: lag.count ? lag.percentile(99) / 1e6 : null,
      max: lag.count ? lag.max / 1e6 : null,
    },
    gc: {
      all: pauses(),
      minor: pauses(constants.NODE_PERFORMANCE_GC_MINOR),
      major: pauses(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
  };
}
type WeightedFrame = { id: number; parent?: number; frame: string; weight: number };
function rank(frames: WeightedFrame[]) {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const totals = new Map<string, { self: number; inclusive: number }>();
  const ancestors = new Map<string, number>();
  for (const source of frames) {
    const seen = new Set<string>();
    let cursor: WeightedFrame | undefined = source;
    const stack: string[] = [];
    while (cursor) {
      stack.push(cursor.frame);
      if (!seen.has(cursor.frame)) {
        const row = totals.get(cursor.frame) ?? { self: 0, inclusive: 0 };
        row.inclusive += source.weight;
        if (cursor === source) {
          row.self += source.weight;
        }
        totals.set(cursor.frame, row);
        seen.add(cursor.frame);
      }
      cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent);
    }
    const target = stack.findIndex((name) =>
      /stableStringify|stringifyStableValue|freezeTrustedJsonSnapshot/.test(name),
    );
    if (target >= 0) {
      const key = stack.slice(target).join(" <- ");
      ancestors.set(key, (ancestors.get(key) ?? 0) + source.weight);
    }
  }
  return {
    total: frames.reduce((sum, frame) => sum + frame.weight, 0),
    functions: [...totals]
      .map(([frame, row]) => ({ frame, self: row.self, inclusive: row.inclusive }))
      .toSorted((a, b) => b.inclusive - a.inclusive)
      .slice(0, 30),
    targetAncestors: [...ancestors]
      .map(([stack, weight]) => ({ stack, weight }))
      .toSorted((a, b) => b.weight - a.weight)
      .slice(0, 20),
  };
}
async function profile() {
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 1000 });
    await waitForStart();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await workload();
    const { profile: heap } = await inspector.post("HeapProfiler.stopSampling");
    await inspector.post("Profiler.start");
    await workload();
    const { profile: cpu } = await inspector.post("Profiler.stop");
    writeFileSync(`${values.output}.cpuprofile`, JSON.stringify(cpu));
    writeFileSync(`${values.output}.heapprofile`, JSON.stringify(heap));
    const label = (frame: Profiler.ProfileNode["callFrame"]) =>
      `${frame.functionName || "(anonymous)"}@${frame.url}:${frame.lineNumber}`;
    const heapFrames: WeightedFrame[] = [];
    const visit = (node: HeapProfiler.SamplingHeapProfileNode, parent?: number) => {
      const id = heapFrames.length;
      heapFrames.push({ id, parent, frame: label(node.callFrame), weight: node.selfSize });
      node.children.forEach((child) => visit(child, id));
    };
    visit(heap.head);
    const parents = new Map<number, number>();
    const weights = new Map<number, number>();
    cpu.nodes.forEach((node) => node.children?.forEach((child) => parents.set(child, node.id)));
    cpu.samples?.forEach((id, index) =>
      weights.set(id, (weights.get(id) ?? 0) + (cpu.timeDeltas?.[index] ?? 0)),
    );
    return {
      sampledAllocationBytes: rank(heapFrames),
      sampledCpuMicroseconds: rank(
        cpu.nodes.map((node) => ({
          id: node.id,
          parent: parents.get(node.id),
          frame: label(node.callFrame),
          weight: weights.get(node.id) ?? 0,
        })),
      ),
      cpuSamples: cpu.samples?.length ?? 0,
    };
  } finally {
    inspector.disconnect();
  }
}
const result = values.profile ? { profile: await profile() } : { measurement: await measure() };
await verify();
lease[Symbol.dispose]();
writeFileSync(
  values.output,
  `${JSON.stringify(
    {
      boundary: "prepareSessionToolSurface owner only; no Gateway or whole-turn claim",
      node: process.version,
      owner: owner.pathname,
      ownerSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
      case: values.case,
      calls,
      tools: 50,
      fieldsPerTool: 20,
      checkpointCount: checkpoints,
      startAt,
      ...result,
    },
    null,
    2,
  )}\n`,
);
