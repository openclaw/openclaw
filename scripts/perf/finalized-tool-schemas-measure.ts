/**
 * Owner-only probe: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/finalized-tool-schemas-measure.ts --factory workboard --rounds 10
 * --sessions 63 --samples 5 --output report.json --golden-output provider.json
 * Workboard mixes the real plugin factory with stable synthetic MCP-shaped tools (60 total).
 * --factory plugin-mix adds visitor-access, xAI, WhatsApp, Lobster, and message factories.
 * --catalogs 24 --sessions 96 exercises interleaved stable tool sets beyond catalog/session LRUs.
 * --provider anthropic exercises Anthropic publication; default is OpenAI.
 * Each round rebuilds execution bindings and settles the real descriptor finalizer.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
import type { OpenClawPluginToolFactory } from "../../src/plugins/tool-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    factory: { type: "string", default: "message" },
    catalogs: { type: "string", default: "1" },
    provider: { type: "string", default: "openai" },
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
const catalogs = integer(values.catalogs, "catalogs", 1);
assert.ok(catalogs <= sessions, "--catalogs must not exceed --sessions");
assert.ok(values.provider === "openai" || values.provider === "anthropic");
const collect = expectDefined(globalThis.gc, "Run with --expose-gc");
const configured = {};
const fixtureDisposals: Array<() => void | Promise<void>> = [];
const factories: Record<string, () => AnyAgentTool[]> = {
  // No configured account, session store, credentials, or tool execution is involved.
  message: () => [createMessageTool()],
  "message-configured": () => [createMessageTool({ config: configured })],
};
if (values.factory === "workboard" || values.factory === "plugin-mix") {
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
  const workboard = () => [
    ...createWorkboardTools({ store, context: { agentId: "schema-probe" } }),
    ...mcpTools,
  ];
  factories.workboard = workboard;
  if (values.factory === "plugin-mix") {
    const { createTestPluginApi } = await import("../../src/plugin-sdk/plugin-test-api.js");
    const { default: plugin } = await import("../../extensions/workboard/index.js");
    const sessionsFactories: OpenClawPluginToolFactory<2>[] = [];
    // Discovery owns a lazy store: registering schemas starts no database worker or service.
    plugin.register(
      createTestPluginApi({
        registrationMode: "tool-discovery",
        runtimeSource: fileURLToPath(
          new URL("../../extensions/workboard/index.ts", import.meta.url),
        ),
        registerTool(tool, options) {
          if (
            options?.names?.includes("workboard_sessions_board_read") &&
            typeof tool === "object" &&
            "create" in tool
          ) {
            sessionsFactories.push(tool);
          }
        },
        lifecycle: {
          registerRuntimeLifecycle({ dispose }) {
            if (dispose) {
              fixtureDisposals.push(dispose);
            }
          },
        },
      }),
    );
    const createSessionsTools = expectDefined(
      sessionsFactories[0],
      "Workboard Sessions board factory",
    ).create;
    const { createVisitorTools } = await import("../../extensions/visitor-access/src/tools.js");
    const { createXSearchToolDefinition } =
      await import("../../extensions/xai/x-search-tool-shared.js");
    const { createCodeExecutionToolDefinition } =
      await import("../../extensions/xai/code-execution-tool-shared.js");
    const { createWhatsAppLoginTool } =
      await import("../../extensions/whatsapp/src/agent-tools-login.js");
    const { createLobsterTool } = await import("../../extensions/lobster/src/lobster-tool.js");
    factories["plugin-mix"] = () => {
      const context = { config: {}, senderIsOwner: true, assertInvocationCurrent() {} };
      const execute = async () => ({ content: [], details: {} });
      const sessionsTools = createSessionsTools(context);
      assert.ok(Array.isArray(sessionsTools));
      return [
        ...sessionsTools,
        ...workboard(),
        createMessageTool(),
        ...createVisitorTools(context),
        createXSearchToolDefinition(execute),
        createCodeExecutionToolDefinition(execute),
        expectDefined(createWhatsAppLoginTool(context), "Owner can discover WhatsApp login"),
        createLobsterTool(),
      ];
    };
  }
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

const catalogTools: AnyAgentTool[] = Array.from({ length: catalogs }, (_, index) => ({
  name: `mcp_scope_${index}`,
  label: "Scoped MCP tool",
  description: "Search the collection admitted for this synthetic workspace.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  execute: async () => ({ content: [], details: {} }),
}));
function toolsForCatalog(index: number): AnyAgentTool[] {
  const tools = expectDefined(factory, "Expected a tool factory")();
  return catalogs === 1 ? tools : [...tools, expectDefined(catalogTools[index], "Catalog tool")];
}

async function construct(
  sessionId: string,
  run = "first",
  sourceTools?: AnyAgentTool[],
  catalog = 0,
) {
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const options = {
    modelProvider: values.provider,
    modelId: "schema-probe",
    modelApi: values.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
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
        tools: sourceTools ?? toolsForCatalog(catalog),
        hookContext: { sessionId, runId },
      });
  for (const cleanup of cleanups) {
    await cleanup("finished");
  }
  return result;
}

async function prepare() {
  clearPluginMetadataLifecycleCaches();
  for (let index = 0; index < catalogs; index++) {
    await construct(`schema-probe-warm-${index}`, "warm", undefined, index);
  }
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
      await construct(`schema-probe-${index}`, `round-${round}`, undefined, index % catalogs);
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
    const sourceTools = factory ? toolsForCatalog(index % catalogs) : undefined;
    const sessionId = `schema-probe-${index}`;
    const finalized = await construct(sessionId, "first", sourceTools);
    const definition = definitionJson(finalized);
    definitions.add(definition);
    // Direct factories can read the settled publication using the exact source objects.
    // Assembly instead constructs a fresh run, exercising both same-session and cross-session reuse.
    const repeated = await construct(sessionId, "repeat", sourceTools);
    assert.equal(definitionJson(repeated), definition, "Provider bytes changed on an equal run");
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
  assert.equal(
    definitions.size,
    catalogs,
    "Provider-facing definitions changed across equal catalogs",
  );
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

const countedNames = [
  "publishParameters",
  "prewarmOpenAISchema",
  "projectToolInputSchema",
  "publishRuntimeToolInputSchema",
  "prepareAnthropicInputSchema",
] as const;
function emptyOwnerCounts() {
  return {
    publishParameters: 0,
    prewarmOpenAISchema: 0,
    projectToolInputSchema: 0,
    publishRuntimeToolInputSchema: 0,
    prepareAnthropicInputSchema: 0,
  };
}
function functionCounts(coverage: Profiler.ScriptCoverage[]) {
  const counts = emptyOwnerCounts();
  const observed = new Set<string>();
  for (const script of coverage) {
    if (
      !/\/(?:agent-tools\.finalize|tool-schema-json-projection|anthropic-tool-projection)\.(?:ts|js)(?:\?|$)/u.test(
        script.url,
      )
    ) {
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
    assert.ok(warm.observed.has("projectToolInputSchema"), "Projection coverage unavailable");
    assert.ok(warm.counts.projectToolInputSchema > 0, "Warmup did not exercise projection");
    await workload();
    const measured = functionCounts((await inspector.post("Profiler.takePreciseCoverage")).result);
    return { turns, warm: warm.counts, afterWarm: measured.counts };
  } finally {
    await inspector.post("Profiler.stopPreciseCoverage");
    await inspector.post("Profiler.disable");
  }
}

function sampledBytes(profile: HeapProfiler.SamplingHeapProfile) {
  const owners = emptyOwnerCounts();
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
  const hostLoad = loadavg();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await workload();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return {
    hostLoad,
    wallMsPerTurn: wallMs / turns,
    cpuMsPerTurn: (used.user + used.system) / 1000 / turns,
  };
}

const attributionResult = await attribution();
const goldens: Record<string, string> = {};
for (let catalog = 0; catalog < catalogs; catalog++) {
  const goldenTools = factory ? toolsForCatalog(catalog) : undefined;
  await construct("schema-probe-golden", "first", goldenTools);
  const publishedTools = await construct("schema-probe-golden", "repeat", goldenTools);
  const variants = {
    responsesLoose: JSON.stringify(convertResponsesToolPayload(publishedTools, { strict: false })),
    responsesStrict: JSON.stringify(convertResponsesToolPayload(publishedTools, { strict: true })),
    anthropic: JSON.stringify(projectAnthropicTools(publishedTools, (name) => name).tools),
  };
  for (const [provider, json] of Object.entries(variants)) {
    goldens[catalogs === 1 ? provider : `${provider}/${catalog}`] = json;
  }
}
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
  for (const dispose of fixtureDisposals) {
    await dispose();
  }
}
const report = {
  boundary: assembly
    ? "Real coding-tool assembly, finalization, and settlement; no Gateway or whole-turn claim"
    : "Tool factory, finalization, and settlement only; no Gateway or whole-turn claim",
  retention: "Forced-GC contextual retained bytes; not natural GC cost, pause, or promotion proof",
  node: process.version,
  factory: values.factory,
  provider: values.provider,
  catalogs,
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
