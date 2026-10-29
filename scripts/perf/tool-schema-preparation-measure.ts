/**
 * Source-owner allocation probe; run on the benchmark host with --expose-gc and scripts/tsx.mjs.
 * --schemas accepts a JSON array of tool descriptors (including OpenAI wire descriptors).
 * --golden-output records exact provider JSON outside measurement for base/head comparison.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { projectAnthropicTools } from "../../packages/ai/src/providers/anthropic-tool-projection.js";
import { convertGoogleTools } from "../../packages/ai/src/providers/google-messages.js";
import { streamMistral } from "../../packages/ai/src/providers/mistral.js";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.js";
import { normalizeOpenAIStrictCompatSchema } from "../../packages/ai/src/providers/openai-tool-schema-compat.js";
import { publishRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "../../packages/ai/src/transports/openai-completions-params.js";
import type { Context, Model } from "../../packages/ai/src/types.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { normalizeOpenAIToolSchemas } from "../../src/plugin-sdk/provider-tools.js";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../src/shared/json-schema.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    schemas: { type: "string" },
    tools: { type: "string", default: "100" },
    iterations: { type: "string", default: "20" },
    samples: { type: "string", default: "5" },
    "sampling-interval": { type: "string", default: "1024" },
    output: { type: "string" },
    "golden-output": { type: "string" },
    "golden-only": { type: "boolean", default: false },
    workload: { type: "string" },
    mode: { type: "string" },
    "start-at": { type: "string" },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const iterations = integer(values.iterations, "iterations");
const samples = integer(values.samples, "samples");
const samplingInterval = integer(values["sampling-interval"], "sampling-interval");
const startAt = values["start-at"] ? integer(values["start-at"], "start-at") : undefined;
const modes = ["warm-published", "fresh-mutable", "cold-publication"] as const;
if (values.mode && !modes.some((mode) => mode === values.mode)) {
  throw new Error(`Unknown mode: ${values.mode}`);
}

function syntheticCatalog(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `catalog_tool_${String(index).padStart(3, "0")}`,
    description: `Search synthetic collection ${index} with structured filters.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text", minLength: 1 },
        options: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            filters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string", enum: ["title", "body", "tag"] },
                  match: { anyOf: [{ enum: ["exact", "prefix"] }, { type: "null" }] },
                },
                required: ["field", "match"],
                additionalProperties: false,
              },
            },
          },
          required: ["limit", "filters"],
          additionalProperties: false,
        },
      },
      required: ["query", "options"],
      additionalProperties: false,
    },
    value: { query: "needle", options: { limit: 10, filters: [] } },
  }));
}

type Entry = { tool: AnyAgentTool & { parameters: JsonSchemaObject }; value: unknown };
const inputJson = values.schemas
  ? readFileSync(values.schemas, "utf8")
  : JSON.stringify(syntheticCatalog(integer(values.tools, "tools")));
function catalog(): Entry[] {
  const input: unknown = JSON.parse(inputJson);
  if (!Array.isArray(input)) {
    throw new Error("--schemas must contain an array of tool descriptors");
  }
  return input.map((entry: unknown) => {
    const descriptor = isRecord(entry) && isRecord(entry.function) ? entry.function : entry;
    if (
      !isRecord(descriptor) ||
      typeof descriptor.name !== "string" ||
      !isRecord(descriptor.parameters)
    ) {
      throw new Error("Every tool needs a string name and object parameters");
    }
    const value = isRecord(entry) && "value" in entry ? entry.value : descriptor.value;
    return {
      tool: {
        name: descriptor.name,
        label: descriptor.name,
        description: typeof descriptor.description === "string" ? descriptor.description : "",
        parameters: descriptor.parameters,
        execute: async () => ({ content: [], details: {} }),
      },
      value: value === undefined ? {} : value,
    };
  });
}

function publish(entries: Entry[]): Entry[] {
  for (const { tool } of entries) {
    const projection = publishRuntimeToolInputSchema(tool.parameters, "parameters", tool.name);
    if (projection.violations.length || !isRecord(projection.schema)) {
      throw new Error(`Cannot publish ${tool.name}: ${projection.violations.join(", ")}`);
    }
    tool.parameters = projection.schema;
  }
  return entries;
}

const model = {
  id: "schema-probe",
  name: "Schema probe",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 128,
} satisfies Model<"openai-completions">;
const moonshotPolicy = {
  mode: "direct" as const,
  compat: { ...resolveOpenAICompletionsCompat(model), requiresTypedUnionBranches: true },
  cacheRetention: "none" as const,
};
const context = (entries: Entry[]): Context => ({
  messages: [{ role: "user", content: "Find the synthetic record.", timestamp: 1 }],
  tools: entries.map(({ tool }) => tool),
});

// The real Mistral SDK serializes into an in-process fetch; no network or credentials are used.
let mistralPayload: unknown;
configureAiTransportHost({
  buildModelFetch: () => async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    mistralPayload = JSON.parse(await request.text());
    const chunk = {
      id: "schema-probe",
      object: "chat.completion.chunk",
      created: 1,
      model: "schema-probe",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

const workloads: Record<string, (entries: Entry[]) => unknown> = {
  "compat-owner": (entries) =>
    entries.map(({ tool }) => normalizeOpenAIStrictCompatSchema(tool.parameters)),
  "sdk-responses-loose": (entries) =>
    convertResponsesToolPayload(
      normalizeOpenAIToolSchemas({
        provider: "openai",
        modelApi: "openai-responses",
        tools: entries.map(({ tool }) => tool),
      }),
      { strict: false },
    ),
  "responses-strict": (entries) =>
    convertResponsesToolPayload(
      entries.map(({ tool }) => tool),
      { strict: true },
    ),
  completions: (entries) =>
    buildOpenAICompletionsParams(model, context(entries), { cacheRetention: "none" }),
  "moonshot-completions": (entries) =>
    buildOpenAICompletionsRequest(model, context(entries), undefined, moonshotPolicy),
  anthropic: (entries) =>
    projectAnthropicTools(
      entries.map(({ tool }) => tool),
      (name) => name,
    ).tools,
  google: (entries) => convertGoogleTools(entries.map(({ tool }) => tool)),
  validation: (entries) =>
    entries.map(({ tool, value }) => validateJsonSchemaValue({ schema: tool.parameters, value })),
  mistral: async (entries) => {
    const result = await streamMistral(
      { ...model, api: "mistral-conversations", provider: "mistral" },
      context(entries),
      { apiKey: "synthetic-benchmark-key", cacheRetention: "none" },
    ).result();
    if (result.stopReason === "error") {
      throw new Error(result.errorMessage);
    }
    return mistralPayload;
  },
};
if (values.workload && !(values.workload in workloads)) {
  throw new Error(`Unknown workload: ${values.workload}`);
}
const selectedWorkloads = Object.entries(workloads).filter(
  ([workload]) => !values.workload || values.workload === workload,
);
const selectedModes = modes.filter((mode) => !values.mode || values.mode === mode);
if (startAt && (selectedWorkloads.length !== 1 || selectedModes.length !== 1 || samples !== 1)) {
  throw new Error("--start-at requires one --workload, one --mode, and --samples 1");
}

function summarizeProfile(profile: HeapProfiler.SamplingHeapProfile) {
  let bytes = 0;
  const functions: Record<string, { self: number; inclusive: number }> = {};
  const named = new Set([
    "inspectJsonSchema",
    "normalizeToolSchemaRecursive",
    "normalizeToolSchema",
    "truncateToolSchemaDepth",
    "projectToolInputSchema",
    "validateJsonSchemaValue",
    "toFunctionTools",
  ]);
  function visit(node: HeapProfiler.SamplingHeapProfileNode, owners: Set<string>) {
    bytes += node.selfSize;
    const name = node.callFrame.functionName;
    const next = named.has(name) ? new Set([...owners, name]) : owners;
    for (const owner of next) {
      const total = (functions[owner] ??= { self: 0, inclusive: 0 });
      total.inclusive += node.selfSize;
      if (owner === name) {
        total.self += node.selfSize;
      }
    }
    for (const child of node.children) {
      visit(child, next);
    }
  }
  visit(profile.head, new Set());
  return { bytes, functions };
}

const goldens: Record<string, string> = {};
const hashes: Record<string, { bytes: number; sha256: string }> = {};
const workCounts: Record<string, Record<string, number>> = {};
for (const [name, run] of Object.entries(workloads)) {
  const stable = publish(catalog());
  const json = JSON.stringify(await run(stable));
  goldens[name] = json;
  hashes[name] = {
    bytes: Buffer.byteLength(json),
    sha256: createHash("sha256").update(json).digest("hex"),
  };
  // Count only operations on the supplied schema graph, separately from sampled allocations.
  const schemas = new WeakSet<object>();
  const pending: unknown[] = stable.map(({ tool }) => tool.parameters);
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object" && !schemas.has(value)) {
      schemas.add(value);
      pending.push(...Object.values(value));
    }
  }
  const counts = {
    sourceSchemaEnumerations: 0,
    sourceSchemaStringifications: 0,
    sourceSchemaClones: 0,
  };
  const original = { entries: Object.entries, stringify: JSON.stringify, clone: structuredClone };
  const observe = <
    T extends typeof Object.entries | typeof JSON.stringify | typeof structuredClone,
  >(
    target: T,
    key: keyof typeof counts,
  ) =>
    new Proxy(target, {
      apply(callable, receiver: unknown, args: unknown[]) {
        const source = args[0];
        if (source && typeof source === "object" && schemas.has(source)) {
          counts[key]++;
        }
        return Reflect.apply(callable, receiver, args);
      },
    });
  try {
    Object.entries = observe(original.entries, "sourceSchemaEnumerations");
    JSON.stringify = observe(original.stringify, "sourceSchemaStringifications");
    globalThis.structuredClone = observe(original.clone, "sourceSchemaClones");
    await run(stable);
  } finally {
    Object.entries = original.entries;
    JSON.stringify = original.stringify;
    globalThis.structuredClone = original.clone;
  }
  workCounts[name] = counts;
}
if (values["golden-output"]) {
  writeFileSync(values["golden-output"], `${JSON.stringify(goldens, null, 2)}\n`);
}

const measurements: Array<{
  workload: string;
  mode: (typeof modes)[number];
  sample: number;
  msPerCatalog: number;
  sampledBytesPerCatalog: number;
  functions: Record<string, { self: number; inclusive: number }>;
}> = [];
if (!values["golden-only"]) {
  if (!globalThis.gc) {
    throw new Error("Run with node --expose-gc");
  }
  const inspector = new Session();
  inspector.connect();
  try {
    for (const [workload, run] of selectedWorkloads) {
      for (const mode of selectedModes) {
        const stable = publish(catalog());
        await run(stable);
        for (let sample = 0; sample < samples; sample++) {
          // Fresh input construction is outside sampling; cold publication remains inside it.
          const inputs = Array.from({ length: iterations }, () =>
            mode === "warm-published" ? stable : catalog(),
          );
          globalThis.gc();
          if (startAt) {
            const wait = startAt - Date.now();
            if (wait <= 0) {
              throw new Error("Missed --start-at; repeat the pair with a later shared start");
            }
            await delay(wait);
          }
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          const started = performance.now();
          for (const entries of inputs) {
            await run(mode === "cold-publication" ? publish(entries) : entries);
          }
          const msPerCatalog = (performance.now() - started) / iterations;
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const allocation = summarizeProfile(profile);
          measurements.push({
            workload,
            mode,
            sample,
            msPerCatalog,
            sampledBytesPerCatalog: allocation.bytes / iterations,
            functions: Object.fromEntries(
              Object.entries(allocation.functions).map(([name, sizes]) => [
                name,
                { self: sizes.self / iterations, inclusive: sizes.inclusive / iterations },
              ]),
            ),
          });
        }
      }
    }
  } finally {
    inspector.disconnect();
  }
}
const report = {
  node: process.version,
  toolCount: catalog().length,
  iterations,
  samples,
  samplingInterval,
  inputSha256: createHash("sha256").update(inputJson).digest("hex"),
  hashes,
  workCounts,
  summary: Object.fromEntries(
    selectedWorkloads.flatMap(([workload]) =>
      selectedModes.map((mode) => {
        const rows = measurements.filter((row) => row.workload === workload && row.mode === mode);
        const distribution = (numbers: number[]) => {
          const sorted = numbers.toSorted((a, b) => a - b);
          return {
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
            min: sorted[0],
            max: sorted.at(-1),
          };
        };
        return [
          `${workload}/${mode}`,
          {
            sampledBytesPerCatalog: distribution(rows.map((row) => row.sampledBytesPerCatalog)),
            msPerCatalog: distribution(rows.map((row) => row.msPerCatalog)),
          },
        ];
      }),
    ),
  ),
  measurements,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (values.output) {
  writeFileSync(values.output, output);
} else {
  process.stdout.write(output);
}
