/**
 * Owner-only probe: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/finalized-tool-schemas-measure.ts --factory workboard --rounds 10
 * --sessions 63 --samples 5 --output report.json --golden-output provider.json
 * Workboard mixes the real plugin factory with stable synthetic MCP-shaped tools (60 total).
 * Each round rebuilds execution bindings and settles the real descriptor finalizer.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { projectAnthropicTools } from "../../packages/ai/src/providers/anthropic-tool-projection.js";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.js";
import { getPublishedRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import { expectDefined } from "../../packages/normalization-core/src/expect.js";
import { finalizeAgentTools } from "../../src/agents/agent-tools.finalize.js";
import type { AnyAgentTool } from "../../src/agents/agent-tools.types.js";
import { createMessageTool } from "../../src/agents/tools/message-tool-execution.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    factory: { type: "string", default: "message" },
    rounds: { type: "string", default: "1" },
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
const rounds = integer(values.rounds, "rounds", 1);
const turns = sessions * rounds;
const samples = integer(values.samples, "samples", 1);
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
if (values.factory === "workboard") {
  const { createWorkboardTools } = await import("../../extensions/workboard/src/tools.js");
  const { WorkboardStore } = await import("../../extensions/workboard/src/store.js");
  // No store operation runs; provider serialization supplies goldens outside measured samples.
  const store = WorkboardStore.prototype;
  const count = createWorkboardTools({ store }).length;
  assert.ok(count < 60);
  const mcpTools: AnyAgentTool[] = Array.from({ length: 60 - count }, (_, index) => ({
    name: `mcp_catalog_${index}`,
    label: "Synthetic MCP search",
    description: "Search a synthetic remote collection.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        filters: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
    execute: async () => ({ content: [], details: {} }),
  }));
  factories.workboard = () => [
    ...createWorkboardTools({ store, context: { agentId: "schema-probe" } }),
    ...mcpTools,
  ];
}
const assembly =
  values.factory === "assembly"
    ? (await import("../../src/agents/agent-tools.js")).createOpenClawCodingToolsInternalAsync
    : undefined;
const factory = assembly
  ? undefined
  : expectDefined(factories[values.factory], `Unknown --factory: ${values.factory}`);
const assemblyConfig: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: { mediaModels: { video: { primary: "qwen/wan2.6-t2v" } } },
  },
  tools: { codeMode: false, toolSearch: false },
  plugins: {
    allow: ["memory-core", "qwen"],
    entries: { "memory-core": { enabled: true }, qwen: { enabled: true } },
  },
};
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

async function construct(sessionId: string, run = "first", sourceTools?: AnyAgentTool[]) {
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const options = {
    modelProvider: "openai",
    modelId: "schema-probe",
    modelApi: "openai-responses",
    wrapBeforeToolCallHook: false,
    registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => cleanups.push(cleanup),
  };
  const runId = `${sessionId}-${run}`;
  const result = assembly
    ? await assembly({
        ...options,
        config: assemblyConfig,
        workspaceDir: process.cwd(),
        agentDir: path.join(expectDefined(process.env.HOME, "Set an isolated HOME"), "agent"),
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:main",
        runId,
        modelHasVision: true,
      })
    : finalizeAgentTools({
        ...options,
        tools: sourceTools ?? expectDefined(factory, "Expected a tool factory")(),
        hookContext: { sessionId, runId },
      });
  for (const cleanup of cleanups) {
    await cleanup("finished");
  }
  return result;
}

async function prepare() {
  clearPluginMetadataLifecycleCaches();
  await construct("schema-probe-warm");
  await collectGarbage();
}

async function collectGarbage() {
  collect();
  await setImmediate();
  collect();
}

async function workload() {
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < sessions; index++) {
      await construct(`schema-probe-${index}`, `round-${round}`);
    }
  }
}

async function attribution() {
  await prepare();
  const byTool = new Map<
    string,
    {
      sources: Set<object>;
      contents: Set<string>;
      published: Set<object>;
      returned: Set<object>;
      publicationMisses: number;
      repeatPublicationMisses: number;
      outputPublicationMisses: number;
    }
  >();
  const definitions = new Set<string>();
  for (let index = 0; index < sessions; index++) {
    const sourceTools = factory?.();
    const sessionId = `schema-probe-${index}`;
    const finalized = await construct(sessionId, "first", sourceTools);
    definitions.add(definitionJson(finalized));
    // Direct factories can read the settled publication using the exact source objects.
    // Assembly instead constructs a fresh run, exercising both same-session and cross-session reuse.
    const repeated = await construct(sessionId, "repeat", sourceTools);
    definitions.add(definitionJson(repeated));
    for (const [position, tool] of finalized.entries()) {
      const next = repeated[position];
      assert.ok(next && next.name === tool.name, "Tool order changed across equal runs");
      const row = byTool.get(tool.name) ?? {
        sources: new Set<object>(),
        contents: new Set<string>(),
        published: new Set<object>(),
        returned: new Set<object>(),
        publicationMisses: 0,
        repeatPublicationMisses: 0,
        outputPublicationMisses: 0,
      };
      const source = sourceTools?.[position];
      if (source) {
        row.sources.add(source.parameters);
      }
      row.contents.add(JSON.stringify(tool.parameters));
      row.returned.add(tool.parameters);
      if (getPublishedRuntimeToolInputSchema(tool.parameters)) {
        row.published.add(tool.parameters);
      } else {
        row.publicationMisses++;
      }
      if (getPublishedRuntimeToolInputSchema(next.parameters)) {
        row.published.add(next.parameters);
      } else {
        row.repeatPublicationMisses++;
      }
      if (tool.outputSchema && !getPublishedRuntimeToolInputSchema(tool.outputSchema)) {
        row.outputPublicationMisses++;
      }
      if (!assembly) {
        assert.ok(
          getPublishedRuntimeToolInputSchema(next.parameters),
          `${tool.name} was not published`,
        );
      }
      byTool.set(tool.name, row);
    }
  }
  assert.equal(definitions.size, 1, "Provider-facing definitions changed across equal runs");
  const firstDefinition = [...definitions][0];
  assert.ok(firstDefinition);
  return {
    sessions,
    runsPerSession: 2,
    identityBoundary: assembly ? "returned normalized parameters" : "factory source parameters",
    publicationMissDefinition: "Returned parameters lack the owner's published-schema marker",
    definitionBytes: Buffer.byteLength(firstDefinition),
    definitionSha256: hash(firstDefinition),
    tools: Object.fromEntries(
      [...byTool].map(([name, row]) => [
        name,
        {
          ...(!assembly ? { distinctSourceObjects: row.sources.size } : {}),
          distinctReturnedParameterObjects: row.returned.size,
          distinctSchemaContents: row.contents.size,
          distinctPublishedSchemas: row.published.size,
          firstRunPublicationMisses: row.publicationMisses,
          sameSessionRepeatPublicationMisses: row.repeatPublicationMisses,
          firstRunOutputPublicationMisses: row.outputPublicationMisses,
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
    return { turns, warm: warm.counts, afterWarm: measured.counts };
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
    totalBytesPerTurn: total / turns,
    ownerBytesPerTurn: Object.fromEntries(
      Object.entries(owners).map(([name, bytes]) => [name, bytes / turns]),
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
    ...(survivors ? { retainedHeapBytesPerTurn: (heapAfter - heapBefore) / turns } : {}),
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
    wallMsPerTurn: wallMs / turns,
    cpuMsPerTurn: (used.user + used.system) / 1000 / turns,
  };
}

const attributionResult = await attribution();
const goldenTools = factory?.();
await construct("schema-probe-golden", "first", goldenTools);
const publishedTools = await construct("schema-probe-golden", "repeat", goldenTools);
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
  boundary: assembly
    ? "Real coding-tool assembly, finalization, and settlement; no Gateway or whole-turn claim"
    : "Tool factory, finalization, and settlement only; no Gateway or whole-turn claim",
  retention: "Forced-GC contextual retained bytes; not natural GC cost, pause, or promotion proof",
  node: process.version,
  factory: values.factory,
  sessionsPerSample: sessions,
  roundsPerSample: rounds,
  turnsPerSample: turns,
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
