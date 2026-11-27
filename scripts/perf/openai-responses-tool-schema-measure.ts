/**
 * Measures warm Responses request construction with 109 published tools and 144 history rows.
 * node --import ./scripts/tsx.mjs scripts/perf/openai-responses-tool-schema-measure.ts
 * Use --baseline-source for the exact pre-change request owner and repeat each arm in
 * separate processes. Use --allocation and --clones in separate passes from CPU timing.
 * Accept fewer clones and lower allocation with identical request bytes, unchanged
 * writable-hook clones and no material CPU or p95 regression outside A/A variation.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { publishRuntimeToolInputSchema } from "../../packages/ai/src/providers/tool-schema-json-projection.js";
import { markModelPayloadObserver } from "../../packages/ai/src/transports/model-request-body.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "baseline-source": { type: "string" },
    allocation: { type: "boolean" },
    clones: { type: "boolean" },
    writable: { type: "boolean" },
  },
});
assert(!(values.allocation && values.clones));
const wasOwnerReplaced = registerPerfOwnerReplacement(
  new URL("../../packages/ai/src/transports/openai-responses-params-internal.ts", import.meta.url)
    .href,
  values["baseline-source"],
);
const { buildOpenAIResponsesParams } =
  await import("../../packages/ai/src/transports/openai-responses-params-internal.js");
assert.equal(wasOwnerReplaced(), Boolean(values["baseline-source"]));

const model: Model = {
  id: "synthetic-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
  messages: Array.from({ length: 144 }, (_, index) => ({
    role: "user",
    content: `Synthetic request ${index}. ${"Context ".repeat(40)}`,
    timestamp: index,
  })),
  tools: Array.from({ length: 109 }, (_, index) => {
    const properties = Object.fromEntries(
      Array.from({ length: 16 }, (_entry, field) => [
        `argument_${field}`,
        { type: "string", description: `Synthetic tool ${index}, argument ${field}.` },
      ]),
    );
    const { schema } = publishRuntimeToolInputSchema({ type: "object", properties });
    assert.ok(isRecord(schema));
    return {
      name: `synthetic_tool_${index}`,
      description: `Synthetic tool ${index}`,
      parameters: schema,
    };
  }),
};
const hook = () => undefined;
const options = { onPayload: values.writable ? hook : markModelPayloadObserver(hook) };
const build = () => buildOpenAIResponsesParams(model, context, options);
const expected = JSON.stringify(buildOpenAIResponsesParams(model, context, undefined));
assert.equal(JSON.stringify(build()), expected);
for (let index = 0; index < 300; index++) {
  build();
}

let clones = 0;
const originalClone = globalThis.structuredClone;
const inspector = new Session();
if (values.clones) {
  globalThis.structuredClone = (value, cloneOptions) => {
    clones++;
    return originalClone(value, cloneOptions);
  };
}
if (values.allocation) {
  await startCollectedHeapSampling(inspector, 4096);
}
const iterations = 1_200;
const durations: number[] = [];
const cpuStart = process.threadCpuUsage();
try {
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    build();
    durations.push(performance.now() - start);
  }
} finally {
  globalThis.structuredClone = originalClone;
}
const cpu = process.threadCpuUsage(cpuStart);
const allocation = values.allocation
  ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
  : undefined;
inspector.disconnect();
assert.equal(JSON.stringify(build()), expected);
durations.sort((left, right) => left - right);
console.log(
  JSON.stringify({
    iterations,
    cpuUsPerRequest: (cpu.user + cpu.system) / iterations,
    p50UsPerRequest: durations[Math.floor(iterations * 0.5)]! * 1_000,
    p95UsPerRequest: durations[Math.floor(iterations * 0.95)]! * 1_000,
    clonesPerRequest: values.clones ? clones / iterations : undefined,
    allocatedBytesPerRequest: allocation === undefined ? undefined : allocation / iterations,
    bytes: Buffer.byteLength(expected),
    digest: hash("sha256", expected),
    load: loadavg()[0],
  }),
);
