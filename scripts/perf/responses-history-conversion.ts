/**
 * Owner-only Responses history conversion + image sanitation measurement.
 * Run against each revision (no Gateway or provider calls):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-history-conversion.ts
 * Use --allocation for a separate sampled allocation pass; --iterations N defaults to 2000.
 * Compare wireSha256 across revisions before interpreting CPU/allocated bytes per request.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";

const iterations = Number(process.argv[process.argv.indexOf("--iterations") + 1]) || 2000;
const allocation = process.argv.includes("--allocation");
const model: Model = {
  id: "fixture-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const imageBytes = Buffer.alloc(16 * 1024, 0x61);
Buffer.from("89504e470d0a1a0a", "hex").copy(imageBytes);
const messages: Context["messages"] = [];
for (let turn = 0; turn < 200; turn++) {
  messages.push({
    role: "user",
    timestamp: turn,
    content: [
      { type: "text", text: `Question ${turn}: `.padEnd(1024, "x") },
      ...(turn % 50 === 0
        ? [{ type: "image" as const, mimeType: "image/jpeg", data: imageBytes.toString("base64") }]
        : []),
    ],
  });
  const call = turn % 5 === 0;
  messages.push({
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp: turn,
    stopReason: call ? "toolUse" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "thinking",
        thinking: "Reasoning",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: `rs_${turn}`,
          summary: [{ type: "summary_text", text: "Reasoning" }],
        }),
      },
      { type: "text", text: `Answer ${turn}: `.padEnd(1024, "y"), textSignature: `msg_${turn}` },
      ...(call
        ? [
            {
              type: "toolCall" as const,
              id: `call_${turn}|fc_${turn}`,
              name: "lookup",
              arguments: { query: `q${turn}` },
            },
          ]
        : []),
    ],
  });
  if (call) {
    messages.push({
      role: "toolResult",
      toolCallId: `call_${turn}|fc_${turn}`,
      toolName: "lookup",
      timestamp: turn,
      isError: false,
      content: [{ type: "text", text: `Result ${turn}` }],
    });
  }
}
const context: Context = { systemPrompt: "Synthetic measurement", messages };
const request = () =>
  sanitizeResponsesImagePayload(buildOpenAIResponsesParams(model, context, undefined));
const first = request();
assert.equal(first.store, false);
const wire = JSON.stringify(first);
assert.equal(JSON.stringify(request()), wire);
const wireSha256 = createHash("sha256").update(wire).digest("hex");
for (let i = 0; i < 50; i++) {
  request();
}
globalThis.gc?.();
const inspector = new Session();
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 8192,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  request();
}
const wallMs = performance.now() - start;
const used = process.cpuUsage(cpu);
let sampledBytes: number | undefined;
if (allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    iterations,
    messages: messages.length,
    images: 4,
    imageBytes: imageBytes.length,
    wireSha256,
    mode: allocation ? "allocation" : "timing",
    cpuUsPerRequest: (used.user + used.system) / iterations,
    wallMs,
    sampledBytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    hostLoad: loadavg(),
    memory: process.memoryUsage(),
  }),
);
