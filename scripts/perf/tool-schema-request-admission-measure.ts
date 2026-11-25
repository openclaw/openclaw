/**
 * Provider-request schema admission probe (synthetic tools; no network or model calls).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-schema-request-admission-measure.ts
 * --tools 40|80 --iterations 2000 --samples 3 --mode repeated|across-runs|published|publication [--strict]
 * Across-runs creates a fresh catalog every 20 requests, outside measurement.
 * Publication measures fresh owner publications and provider variants each turn, including
 * consuming the source canonical fingerprints for prompt diagnostics. Use --strict for
 * strict provider prewarming. --tools 80 models two tools from each of 40 synthetic plugins.
 * CPU is untraced; allocation is sampled separately, including collected objects.
 * Compare baseline/candidate in counterbalanced order with the same arguments.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { HeapProfiler, Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { convertResponsesToolPayload } from "../../packages/ai/src/providers/openai-responses-tools.js";
import {
  getPublishedRuntimeToolInputSchema,
  publishRuntimeToolInputSchema,
} from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import type { Tool } from "../../packages/ai/src/types.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    tools: { type: "string", default: "80" },
    iterations: { type: "string", default: "2000" },
    samples: { type: "string", default: "3" },
    mode: { type: "string", default: "repeated" },
    strict: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const toolCount = integer(values.tools, "tools");
const iterations = integer(values.iterations, "iterations");
const samples = integer(values.samples, "samples");
assert.ok(["repeated", "across-runs", "published", "publication"].includes(values.mode));
const collectGarbage = globalThis.gc;
assert.ok(collectGarbage, "Run with --expose-gc");

function catalog(): Tool[] {
  return Array.from({ length: toolCount }, (_, index) => {
    const parameters = {
      type: "object",
      properties: {
        query: { type: "string", description: "Synthetic search query", minLength: 1 },
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
                  match: values.strict
                    ? { type: "string", enum: ["exact", "prefix"] }
                    : { anyOf: [{ type: "string", enum: ["exact", "prefix"] }, { type: "null" }] },
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
    };
    return {
      name: `catalog_tool_${String(index).padStart(3, "0")}`,
      description: `Search synthetic collection ${index}.`,
      parameters,
    };
  });
}

function fixtures() {
  const catalogs = Array.from(
    { length: values.mode === "across-runs" ? Math.ceil(iterations / 20) : 1 },
    catalog,
  );
  if (values.mode === "published") {
    for (const tool of catalogs[0]!) {
      const projection = publishRuntimeToolInputSchema(tool.parameters);
      assert.ok(isRecord(projection.schema));
      tool.parameters = projection.schema;
    }
  }
  convertResponsesToolPayload(catalogs[0]!, { strict: values.strict });
  return catalogs;
}

function run(catalogs: Tool[][]) {
  let emitted = 0;
  for (let index = 0; index < iterations; index++) {
    const sources = catalogs[values.mode === "across-runs" ? Math.floor(index / 20) : 0]!;
    const tools = values.mode === "publication" ? publishCatalog(sources) : sources;
    emitted += convertResponsesToolPayload(tools, { strict: values.strict }).length;
  }
  assert.equal(emitted, toolCount * iterations);
}

function publishCatalog(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    const { schema, violations } = publishRuntimeToolInputSchema(tool.parameters);
    assert.equal(violations.length, 0);
    assert.ok(isRecord(schema));
    assert.ok(getPublishedRuntimeToolInputSchema(schema)?.canonicalFingerprint);
    return { ...tool, parameters: schema };
  });
}

function countFunctions(coverage: Profiler.ScriptCoverage[]) {
  let publications = 0;
  let canonicalSerializations = 0;
  for (const script of coverage) {
    for (const entry of script.functions) {
      const count = entry.ranges[0]?.count ?? 0;
      if (
        script.url.includes("tool-schema-json-projection.") &&
        entry.functionName === "projectToolInputSchema"
      ) {
        publications += count;
      }
      if (entry.functionName === "stableStringify") {
        canonicalSerializations += count;
      }
    }
  }
  return { publications, canonicalSerializations };
}

function bytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
}

const goldenCatalog = catalog();
const goldenPayload = convertResponsesToolPayload(goldenCatalog, { strict: values.strict });
assert.ok(goldenPayload.every((tool) => tool.strict === values.strict));
const golden = JSON.stringify(goldenPayload);
// Key sorting preserves the byte length of these JSON-only fixtures. Both publications
// (source and provider variant) have the same length, so coverage supplies exact byte work.
const schemaBytes = Buffer.byteLength(JSON.stringify(goldenCatalog[0]!.parameters));
if (values.mode === "publication") {
  for (const tool of goldenPayload) {
    assert.equal(Buffer.byteLength(JSON.stringify(tool.parameters)), schemaBytes);
  }
}
const goldenSchema = publishRuntimeToolInputSchema(goldenCatalog[0]!.parameters).schema;
const schemaHash = getPublishedRuntimeToolInputSchema(goldenSchema)?.canonicalFingerprint;
const parityInputs = fixtures();
for (const tools of parityInputs) {
  assert.equal(
    JSON.stringify(
      convertResponsesToolPayload(values.mode === "publication" ? publishCatalog(tools) : tools, {
        strict: values.strict,
      }),
    ),
    golden,
  );
}
run(parityInputs);
for (const tools of parityInputs) {
  assert.equal(
    JSON.stringify(convertResponsesToolPayload(tools, { strict: values.strict })),
    golden,
  );
}
const rows = [];
const inspector = new Session();
inspector.connect();
let workCounts;
try {
  if (values.mode === "publication") {
    const inputs = fixtures();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
    run(inputs);
    workCounts = countFunctions((await inspector.post("Profiler.takePreciseCoverage")).result);
    await inspector.post("Profiler.stopPreciseCoverage");
    await inspector.post("Profiler.disable");
  }
  for (let sample = 0; sample < samples; sample++) {
    const timingInputs = fixtures();
    collectGarbage();
    const hostLoad = loadavg();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    run(timingInputs);
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const allocationInputs = fixtures();
    collectGarbage();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(allocationInputs);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    rows.push({
      sample,
      cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
      wallUsPerRequest: (wallMs * 1000) / iterations,
      sampledBytesPerRequest: bytes(profile.head) / iterations,
      hostLoad,
    });
  }
} finally {
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    node: process.version,
    toolCount,
    iterations,
    samples,
    mode: values.mode,
    strict: values.strict,
    payloadBytes: Buffer.byteLength(golden),
    payloadSha256: createHash("sha256").update(golden).digest("hex"),
    schemaHash,
    workCounts,
    ...(workCounts
      ? {
          firstPublicationsPerTurn: workCounts.publications / iterations,
          canonicalSerializationsPerTurn: workCounts.canonicalSerializations / iterations,
          canonicalSerializedBytesPerTurn:
            (workCounts.canonicalSerializations * schemaBytes) / iterations,
        }
      : {}),
    selectedModePayloadVerified: true,
    rows,
  }),
);
