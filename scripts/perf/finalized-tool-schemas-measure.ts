// Owner-only probe: run on the benchmark host with --expose-gc and scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { projectAnthropicTools } from "../../packages/ai/src/providers/anthropic-tool-projection.js";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.js";
import { getPublishedRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import { expectDefined } from "../../packages/normalization-core/src/expect.js";
import { finalizeAgentTools } from "../../src/agents/agent-tools.finalize.js";
import type { AnyAgentTool } from "../../src/agents/agent-tools.types.js";
import { createMessageTool } from "../../src/agents/tools/message-tool-execution.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    factory: { type: "string", default: "message" },
    sessions: { type: "string", default: "63" },
    samples: { type: "string", default: "5" },
    "sampling-interval": { type: "string", default: "1024" },
    output: { type: "string" },
    "golden-output": { type: "string" },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const sessions = integer(values.sessions, "sessions", 1);
const samples = integer(values.samples, "samples", 5);
const samplingInterval = integer(values["sampling-interval"], "sampling-interval", 1);
// Include the warm session within the finalizer's 64 retained snapshots.
assert.ok(sessions <= 63, "--sessions must be <= 63 to avoid warm-snapshot eviction");
const collect = expectDefined(globalThis.gc, "Run with --expose-gc");
const configured = {};
const factories: Record<string, () => AnyAgentTool[]> = {
  // No configured account, session store, credentials, or tool execution is involved.
  message: () => [createMessageTool()],
  "message-configured": () => [createMessageTool({ config: configured })],
};
const factory = expectDefined(factories[values.factory], `Unknown --factory: ${values.factory}`);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const definitionJson = (tools: AnyAgentTool[]) =>
  JSON.stringify(
    tools.map(({ name, description, parameters, outputSchema }) => ({
      name,
      description,
      parameters,
      outputSchema,
    })),
  );

async function finalize(tools: AnyAgentTool[], sessionId: string, run = "first") {
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const result = finalizeAgentTools({
    tools,
    modelProvider: "openai",
    modelId: "schema-probe",
    modelApi: "openai-responses",
    hookContext: { sessionId, runId: `${sessionId}-${run}` },
    wrapBeforeToolCallHook: false,
    registerRunCleanup: (cleanup) => cleanups.push(cleanup),
  });
  for (const cleanup of cleanups) {
    await cleanup("finished");
  }
  return result;
}

async function prepare() {
  clearPluginMetadataLifecycleCaches();
  await finalize(factory(), "schema-probe-warm");
  await collectGarbage();
}

async function collectGarbage() {
  collect();
  await setImmediate();
  collect();
}

async function workload() {
  for (let index = 0; index < sessions; index++) {
    await finalize(factory(), `schema-probe-${index}`);
  }
}

async function attribution() {
  await prepare();
  const byTool = new Map<
    string,
    { sources: Set<object>; contents: Set<string>; published: Set<object> }
  >();
  const definitions = new Set<string>();
  for (let index = 0; index < sessions; index++) {
    const tools = factory();
    const sessionId = `schema-probe-${index}`;
    const finalized = await finalize(tools, sessionId);
    definitions.add(definitionJson(finalized));
    // Read the owner's settled publication without replacing this run's source object.
    const published = await finalize(tools, sessionId, "read-publication");
    for (const [position, tool] of tools.entries()) {
      const parameters = published[position]?.parameters;
      assert.ok(parameters && typeof parameters === "object");
      assert.ok(getPublishedRuntimeToolInputSchema(parameters), `${tool.name} was not published`);
      const row = byTool.get(tool.name) ?? {
        sources: new Set<object>(),
        contents: new Set<string>(),
        published: new Set<object>(),
      };
      row.sources.add(tool.parameters);
      row.contents.add(JSON.stringify(tool.parameters));
      row.published.add(parameters);
      byTool.set(tool.name, row);
    }
  }
  assert.equal(definitions.size, 1, "Provider-facing definitions changed across equal sessions");
  const firstDefinition = [...definitions][0];
  assert.ok(firstDefinition);
  return {
    sessions,
    definitionBytes: Buffer.byteLength(firstDefinition),
    definitionSha256: hash(firstDefinition),
    tools: Object.fromEntries(
      [...byTool].map(([name, row]) => [
        name,
        {
          distinctSourceObjects: row.sources.size,
          distinctSchemaContents: row.contents.size,
          distinctPublishedSchemas: row.published.size,
        },
      ]),
    ),
  };
}

const countedNames = ["publishParameters", "prewarmOpenAISchema"] as const;
function functionCounts(coverage: Profiler.ScriptCoverage[]) {
  const counts = { publishParameters: 0, prewarmOpenAISchema: 0 };
  const observed = new Set<string>();
  for (const script of coverage) {
    if (!/\/agent-tools\.finalize\.(?:ts|js)(?:\?|$)/u.test(script.url)) {
      continue;
    }
    for (const entry of script.functions) {
      for (const name of countedNames) {
        if (entry.functionName === name) {
          observed.add(name);
          counts[name] += entry.ranges[0]?.count ?? 0;
        }
      }
    }
  }
  return { counts, observed };
}

async function workCounts(inspector: Session) {
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  try {
    await prepare();
    const warm = functionCounts((await inspector.post("Profiler.takePreciseCoverage")).result);
    for (const name of countedNames) {
      assert.ok(warm.observed.has(name), `Coverage did not observe ${name}; counts unavailable`);
      assert.ok(warm.counts[name] > 0, `Warm publication did not exercise ${name}`);
    }
    await workload();
    const measured = functionCounts((await inspector.post("Profiler.takePreciseCoverage")).result);
    return { sessions, warm: warm.counts, afterWarm: measured.counts };
  } finally {
    await inspector.post("Profiler.stopPreciseCoverage");
    await inspector.post("Profiler.disable");
  }
}

function sampledBytes(profile: HeapProfiler.SamplingHeapProfile) {
  const owners = { publishParameters: 0, prewarmOpenAISchema: 0 };
  let total = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, ancestors: Set<string>) => {
    total += node.selfSize;
    const current = new Set(ancestors);
    if (countedNames.some((name) => name === node.callFrame.functionName)) {
      current.add(node.callFrame.functionName);
    }
    for (const name of countedNames) {
      if (current.has(name)) {
        owners[name] += node.selfSize;
      }
    }
    for (const child of node.children) {
      visit(child, current);
    }
  };
  visit(profile.head, new Set());
  return {
    sampledObjects: profile.samples.length,
    totalBytesPerSession: total / sessions,
    ownerBytesPerSession: Object.fromEntries(
      Object.entries(owners).map(([name, bytes]) => [name, bytes / sessions]),
    ),
  };
}

async function sampleHeap(inspector: Session, survivors: boolean) {
  await prepare();
  const heapBefore = process.memoryUsage().heapUsed;
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval,
    includeObjectsCollectedByMajorGC: !survivors,
    includeObjectsCollectedByMinorGC: !survivors,
  });
  await workload();
  if (survivors) {
    await collectGarbage();
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  return {
    ...sampledBytes(profile),
    ...(survivors ? { retainedHeapBytesPerSession: (heapAfter - heapBefore) / sessions } : {}),
  };
}

async function sampleUntraced() {
  await prepare();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await workload();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return {
    wallMsPerSession: wallMs / sessions,
    cpuMsPerSession: (used.user + used.system) / 1000 / sessions,
  };
}

const attributionResult = await attribution();
const goldenTools = factory();
await finalize(goldenTools, "schema-probe-golden");
const publishedTools = await finalize(goldenTools, "schema-probe-golden", "read-publication");
const goldens = {
  responsesLoose: JSON.stringify(convertResponsesToolPayload(publishedTools, { strict: false })),
  responsesStrict: JSON.stringify(convertResponsesToolPayload(publishedTools, { strict: true })),
  anthropic: JSON.stringify(projectAnthropicTools(publishedTools, (name) => name).tools),
};
if (values["golden-output"]) {
  writeFileSync(values["golden-output"], `${JSON.stringify(goldens, null, 2)}\n`);
}

// Timing stays outside inspector instrumentation; allocation and survivors use separate passes.
const untraced = [];
for (let sample = 0; sample < samples; sample++) {
  untraced.push({ sample, ...(await sampleUntraced()) });
}
const inspector = new Session();
inspector.connect();
const allocations = [];
const survivors = [];
let counts: Awaited<ReturnType<typeof workCounts>>;
try {
  counts = await workCounts(inspector);
  for (let sample = 0; sample < samples; sample++) {
    allocations.push({ sample, ...(await sampleHeap(inspector, false)) });
    survivors.push({ sample, ...(await sampleHeap(inspector, true)) });
  }
} finally {
  inspector.disconnect();
  clearPluginMetadataLifecycleCaches();
}
const report = {
  boundary: "Tool factory, finalization, and settlement only; no Gateway or whole-turn claim",
  retention: "Forced-GC contextual retained bytes; not natural GC cost, pause, or promotion proof",
  node: process.version,
  factory: values.factory,
  sessionsPerSample: sessions,
  samplesPerMode: samples,
  samplingInterval,
  attribution: attributionResult,
  workCounts: counts,
  providerBytes: Object.fromEntries(
    Object.entries(goldens).map(([name, json]) => [
      name,
      { bytes: Buffer.byteLength(json), sha256: hash(json) },
    ]),
  ),
  untraced,
  allocations,
  survivors,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) {
  writeFileSync(values.output, output);
} else {
  process.stdout.write(output);
}
