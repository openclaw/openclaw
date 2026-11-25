// Owner benchmark: Node --expose-gc --import ./scripts/tsx.mjs, one fresh process per sample.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { constants, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  readToolOutputSchemaVariants,
  selectToolOutputSchema,
} from "../../src/agents/schema/tool-output-schema.js";
import { LruCache } from "../../src/infra/lru-cache.js";
import {
  validateJsonSchemaValue,
  type JsonSchemaValue,
} from "../../src/plugins/schema-validator.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    tools: { type: "string", default: "96" },
    calls: { type: "string", default: "12000" },
    mutable: { type: "boolean", default: false },
    "counts-only": { type: "boolean", default: false },
    "sampling-interval": { type: "string", default: "4096" },
    output: { type: "string" },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const toolCount = integer(values.tools, "tools");
const calls = integer(values.calls, "calls");
const workloadLifetime =
  "Each pass is synchronous: WeakRef targets remain live until the job yields. Above-capacity reuse counts do not predict inter-call GC behavior. Retention is measured after yielding and forced GC.";
const samplingInterval = integer(values["sampling-interval"], "sampling-interval");
const collect = globalThis.gc;
assert.ok(collect, "Run with --expose-gc");
const actions = ["read", "search", "create", "update"];
const catalog = Array.from({ length: toolCount }, (_, tool) => {
  const fields = Object.fromEntries(
    Array.from({ length: 8 + (tool % 17) }, (_field, field) => [
      `field_${field}`,
      {
        type: "string",
        description: `Synthetic field ${field}: a descriptive value returned by tool ${tool}, preserved in its documented output.`,
        maxLength: 512,
      },
    ]),
  );
  const input = {
    type: "object",
    title: `tool_${tool}_input`,
    additionalProperties: false,
    properties: {
      action: { enum: actions },
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      options: { type: "object", properties: fields },
    },
    required: ["action", "query"],
  };
  const output = {
    title: `tool_${tool}_output`,
    anyOf: actions.map((action) => ({
      type: "object",
      additionalProperties: false,
      properties: {
        action: { const: action },
        items: {
          type: "array",
          items: { type: "object", properties: fields, additionalProperties: false },
        },
        count: { type: "integer", minimum: 0 },
      },
      required: ["action", "items", "count"],
    })),
    "x-openclaw-input-discriminator": {
      version: 1,
      inputProperty: "action",
      mapping: Object.fromEntries(actions.map((action, index) => [action, index])),
    },
  };
  const entry = { input, output };
  return values.mutable ? entry : freezeTrustedJsonSnapshot(entry);
});
const inputs = actions.map((action) => ({ action, query: "synthetic query", limit: 10 }));
const outputs = actions.map((action) => ({
  action,
  items: [{ field_0: "synthetic result" }],
  count: 1,
}));
const schemaBytes = catalog.flatMap(({ input, output }) => [
  JSON.stringify(input).length,
  JSON.stringify(output).length,
]);
let checksum = 0;
function workload(count: number) {
  for (let operation = 0; operation < count; operation++) {
    const tool = catalog[operation % toolCount]!;
    const action = Math.floor(operation / toolCount) % actions.length;
    // ToolSearchRuntime validates output at preflight and twice around result projection.
    const preflight = validateJsonSchemaValue({
      schema: selectToolOutputSchema(tool.output, undefined) as JsonSchemaValue,
      value: undefined,
    });
    readToolOutputSchemaVariants(tool.output);
    const input = validateJsonSchemaValue({ schema: tool.input, value: inputs[action] });
    const output = validateJsonSchemaValue({
      schema: selectToolOutputSchema(tool.output, inputs[action]) as JsonSchemaValue,
      value: outputs[action],
    });
    const acceptedOutput = validateJsonSchemaValue({
      schema: selectToolOutputSchema(tool.output, inputs[action]) as JsonSchemaValue,
      value: outputs[action],
    });
    if (preflight.ok || !input.ok || !output.ok || !acceptedOutput.ok) {
      throw new Error(
        `Unexpected validation result for tool ${operation % toolCount}, action ${action}`,
      );
    }
    checksum += 4;
  }
}
async function gc() {
  collect!();
  await setImmediate();
  collect!();
  await setImmediate();
}
const inspector = new Session();
inspector.connect();

// Observe the existing LRU owner only in the counts pass. Never instrument timed samples.
const descriptors = Object.getOwnPropertyDescriptors(LruCache.prototype);
const get = descriptors.get.value;
const set = descriptors.set.value;
assert.ok(get && set);
let residentEntries = 0;
const slots = new Map<string, { admissions: number; hits: number }>();
let lookups = 0;
let hits = 0;
const checkpoints: Array<{ calls: number; entries: number; hits: number; lookups: number }> = [];
LruCache.prototype.get = function (key) {
  lookups++;
  const result = get.call(this, key);
  if (result !== undefined) {
    hits++;
    const slot = slots.get(key);
    if (slot) {
      slot.hits++;
    }
  }
  return result;
};
LruCache.prototype.set = function (key, value) {
  const slot = slots.get(key) ?? { admissions: 0, hits: 0 };
  slot.admissions++;
  slots.set(key, slot);
  set.call(this, key, value);
  residentEntries = this.size;
};
await gc();
const coldHeapBefore = process.memoryUsage().heapUsed;
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval,
  includeObjectsCollectedByMajorGC: false,
  includeObjectsCollectedByMinorGC: false,
});
try {
  for (let round = 0; round < 8; round++) {
    workload(toolCount * actions.length);
    checkpoints.push({
      calls: (round + 1) * toolCount * actions.length,
      entries: residentEntries,
      hits,
      lookups,
    });
  }
} finally {
  Object.defineProperties(LruCache.prototype, descriptors);
}
function heapBytes(profile: HeapProfiler.SamplingHeapProfile) {
  let total = 0;
  let keyPath = 0;
  let validation = 0;
  let compilation = 0;
  let selection = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, ancestors: string[]) => {
    const names = [...ancestors, node.callFrame.functionName];
    total += node.selfSize;
    if (names.some((name) => ["stringify", "isDeeplyFrozenPlainData", "get"].includes(name))) {
      keyPath += node.selfSize;
    }
    if (names.includes("checkSchema")) {
      validation += node.selfSize;
    }
    if (names.includes("compileSchema")) {
      compilation += node.selfSize;
    }
    if (names.includes("selectToolOutputSchema")) {
      selection += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, names);
    }
  };
  visit(profile.head, []);
  return {
    sampledObjects: profile.samples.length,
    total,
    keyPath,
    validation,
    compilation,
    selection,
  };
}
const countReport = {
  toolCalls: toolCount * actions.length * 8,
  validationCalls: toolCount * actions.length * 8 * 4,
  lookups,
  hits,
  distinctContentSlots: slots.size,
  admissions: [...slots.values()].reduce((sum, slot) => sum + slot.admissions, 0),
  reusedSlots: [...slots.values()].filter((slot) => slot.hits > 0).length,
  residentEntries,
  checkpoints,
};
// Release observation keys and their bookkeeping before allocation/timing measurements.
slots.clear();
await gc();
const coldHeapAfter = process.memoryUsage().heapUsed;
const retained = (await inspector.post("HeapProfiler.stopSampling")).profile;
if (values["counts-only"]) {
  inspector.disconnect();
  process.stdout.write(
    `${JSON.stringify({ workloadLifetime, countReport, schemaBytes: { min: Math.min(...schemaBytes), max: Math.max(...schemaBytes) }, retained: heapBytes(retained), coldHeapDelta: coldHeapAfter - coldHeapBefore }, null, 2)}\n`,
  );
  process.exit(0);
}
const pauses: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as unknown as { detail: { kind: number } }).detail;
    pauses.push({ kind: detail.kind, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const cpuStart = process.cpuUsage();
const start = performance.now();
workload(calls);
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
await setImmediate();
await setImmediate();
observer.disconnect();
const untraced = {
  calls,
  validationCalls: calls * 4,
  wallMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  cpuUsPerValidation: (cpu.user + cpu.system) / (calls * 4),
  gcMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
  maxPauseMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
  gcByKind: Object.fromEntries(
    [
      constants.NODE_PERFORMANCE_GC_MINOR,
      constants.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP,
      constants.NODE_PERFORMANCE_GC_MAJOR,
      constants.NODE_PERFORMANCE_GC_INCREMENTAL,
      constants.NODE_PERFORMANCE_GC_WEAKCB,
    ].map((kind) => [
      kind,
      {
        count: pauses.filter((pause) => pause.kind === kind).length,
        ms: pauses
          .filter((pause) => pause.kind === kind)
          .reduce((sum, pause) => sum + pause.duration, 0),
      },
    ]),
  ),
};
await gc();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
workload(calls);
const allocations = heapBytes((await inspector.post("HeapProfiler.stopSampling")).profile);
await inspector.post("Profiler.enable");
await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
await inspector.post("Profiler.start");
workload(calls);
const cpuProfile = (await inspector.post("Profiler.stop")).profile;
await inspector.post("Profiler.disable");
function cpuBreakdown(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id);
    }
  }
  const categories = {
    selection: 0,
    validation: 0,
    compilation: 0,
    keyPath: 0,
    validatorOther: 0,
    other: 0,
  };
  for (const [index, sample] of (profile.samples ?? []).entries()) {
    const names = [];
    let id: number | undefined = sample;
    while (id !== undefined) {
      names.push(nodes.get(id)?.callFrame.functionName ?? "");
      id = parents.get(id);
    }
    const category = names.includes("selectToolOutputSchema")
      ? "selection"
      : names.includes("compileSchema")
        ? "compilation"
        : names.includes("checkSchema")
          ? "validation"
          : names.some((name) => ["stringify", "isDeeplyFrozenPlainData", "get"].includes(name))
            ? "keyPath"
            : names.includes("validateJsonSchemaValue")
              ? "validatorOther"
              : "other";
    categories[category] += profile.timeDeltas?.[index] ?? 0;
  }
  return {
    samples: profile.samples?.length ?? 0,
    microseconds: categories,
    note: "Sampled CPU attribution is contextual; validatorOther includes inlined cache-key work. Untraced CPU is the decision metric.",
  };
}
inspector.disconnect();
await gc();
const beforeDrop = process.memoryUsage().heapUsed;
catalog.length = 0;
await gc();
const afterDrop = process.memoryUsage().heapUsed;
const report = {
  boundary:
    "Real schema validator and output-selection owners in Tool Search validation order; no Gateway, tool execution, or whole-turn claim",
  workloadLifetime,
  node: process.version,
  load: loadavg(),
  tools: toolCount,
  mutable: values.mutable,
  schemaBytes: {
    min: Math.min(...schemaBytes),
    max: Math.max(...schemaBytes),
    total: schemaBytes.reduce((sum, size) => sum + size, 0),
  },
  countReport,
  untraced,
  allocations: {
    ...allocations,
    bytesPerValidation: allocations.total / (calls * 4),
    selectionBytesPerCall: allocations.selection / calls,
  },
  retention: {
    note: "Forced-GC cold heap delta excludes released LRU observer keys but includes code and inspector overhead; sampled compilation survivors are an estimate, not exact dominator retained size",
    coldHeapDelta: coldHeapAfter - coldHeapBefore,
    releasedAfterCatalogDrop: beforeDrop - afterDrop,
    ...heapBytes(retained),
  },
  sampledCpu: cpuBreakdown(cpuProfile),
  checksum,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) {
  writeFileSync(values.output, json);
} else {
  process.stdout.write(json);
}
