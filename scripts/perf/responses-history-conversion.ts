/**
 * Owner-only Responses history conversion + image sanitation measurement.
 * Run against each revision (no Gateway or provider calls):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-history-conversion.ts
 * Use --allocation for a separate sampled allocation pass; --iterations N defaults to 2000.
 * --retained measures post-GC growth with 20 live 500-KiB images and discarded requests.
 * Add --normalize-mime to test MIME-only normalization. The snapshot counts large
 * image strings separately from small cache metadata and unrelated heap noise.
 * For frozen transcript reuse: --messages 40 (or 150) --frozen [--hook]
 * adds 8-KiB tool arguments/results and the production transport transform. --hook
 * includes mutable input preparation required by the agent's payload callback.
 * --conversion-only omits post-conversion image sanitation; default measures both.
 * Run at least five alternating base/candidate arms per workload and mode. Accept
 * identical wireSha256 and consistent CPU/allocation reductions without material
 * controlled GC regression. Timing/GC gates use untraced runs, allocation is separate.
 * Compare wireSha256 across revisions before interpreting CPU/allocated bytes per request.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getHeapSnapshot } from "node:v8";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { transformTransportMessages } from "../../src/agents/transport-message-transform.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";

const iterations = Number(process.argv[process.argv.indexOf("--iterations") + 1]) || 2000;
const allocation = process.argv.includes("--allocation");
const messageCount = Number(process.argv[process.argv.indexOf("--messages") + 1]) || undefined;
const frozen = process.argv.includes("--frozen");
const hook = process.argv.includes("--hook");
const conversionOnly = process.argv.includes("--conversion-only");
const options = hook ? { onPayload: () => undefined } : undefined;
if (messageCount !== undefined) {
  assert(messageCount === 40 || messageCount === 150, "--messages must be 40 or 150");
}
if (messageCount !== undefined || frozen) {
  configureAiTransportHost({
    transformTransportMessages,
    immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  });
}
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

if (process.argv.includes("--retained")) {
  assert(globalThis.gc, "--retained requires --expose-gc");
  const gc = globalThis.gc;
  const mimeType = process.argv.includes("--normalize-mime") ? "image/jpeg" : "image/png";
  const fixture = (bytes: number): Context => {
    const history: Context = {
      messages: Array.from({ length: 20 }, (_, index) => {
        const image = Buffer.alloc(bytes, index);
        Buffer.from("89504e470d0a1a0a", "hex").copy(image);
        // Model history is decoded from JSON; keep distinct flat source strings live.
        const data: string = JSON.parse(`"${image.toString("base64")}"`);
        return {
          role: "user",
          timestamp: index,
          content: [{ type: "image", mimeType, data }],
        };
      }),
    };
    if (frozen) {
      history.messages.forEach(freezeJsonSnapshot);
    }
    return history;
  };
  const send = (history: Context) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          sanitizeResponsesImagePayload(buildOpenAIResponsesParams(model, history, options)),
        ),
      )
      .digest("hex");
  const warm = fixture(128);
  for (let i = 0; i < 100; i++) {
    send(warm);
  }
  const samples = [];
  let retainedImageStrings: { count: number; bytes: number } | undefined;
  for (let sample = 0; sample < 5; sample++) {
    const history = fixture(500 * 1024);
    await nextTurn();
    gc();
    gc();
    const before = process.memoryUsage();
    const digest = send(history);
    for (let i = 0; i < 4; i++) {
      assert.equal(send(history), digest);
    }
    await nextTurn();
    gc();
    gc();
    const after = process.memoryUsage();
    // Read the source after GC so the history cannot become dead before measurement.
    assert.equal(history.messages.length, 20);
    samples.push({
      sample,
      wireSha256: digest,
      retainedHeapBytes: after.heapUsed - before.heapUsed,
      retainedExternalBytes: after.external - before.external,
    });
    if (sample === 4) {
      const chunks: Buffer[] = [];
      for await (const chunk of getHeapSnapshot()) {
        chunks.push(chunk);
      }
      const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        snapshot: { meta: { node_fields: string[] } };
        nodes: number[];
        strings: string[];
      };
      const fields = snapshot.snapshot.meta.node_fields;
      const name = fields.indexOf("name");
      const size = fields.indexOf("self_size");
      assert(name >= 0 && size >= 0, "snapshot must describe node names and sizes");
      retainedImageStrings = { count: 0, bytes: 0 };
      for (let index = 0; index < snapshot.nodes.length; index += fields.length) {
        const nameIndex = snapshot.nodes[index + name];
        const bytes = snapshot.nodes[index + size];
        assert(nameIndex !== undefined && bytes !== undefined, "snapshot node must be complete");
        const value = snapshot.strings[nameIndex];
        assert(value !== undefined, "snapshot node name must exist");
        if (bytes > 500 * 1024 && /^(?:data:image\/[^,]+,)?iVBORw0KGgo/.test(value)) {
          retainedImageStrings.count++;
          retainedImageStrings.bytes += bytes;
        }
      }
      assert(retainedImageStrings.count >= 20, "snapshot must include all live image payloads");
      assert.equal(history.messages.length, 20);
    }
  }
  console.log(
    JSON.stringify({
      mode: "retained",
      frozen,
      hook,
      images: 20,
      imageBytes: 500 * 1024,
      mimeType,
      retainedImageStrings,
      samples,
    }),
  );
  process.exit(0);
}
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
              arguments: { query: messageCount ? `q${turn}`.padEnd(8192, "q") : `q${turn}` },
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
      content: [
        {
          type: "text",
          text: messageCount ? `Result ${turn}`.padEnd(8192, "r") : `Result ${turn}`,
        },
      ],
    });
  }
}
if (messageCount !== undefined) {
  messages.length = messageCount;
}
if (frozen) {
  messages.forEach(freezeJsonSnapshot);
}
const context: Context = { systemPrompt: "Synthetic measurement", messages };
const request = () => {
  const params = buildOpenAIResponsesParams(model, context, options);
  return conversionOnly ? params : sanitizeResponsesImagePayload(params);
};
globalThis.gc?.();
const retainedBefore = process.memoryUsage();
const first = request();
assert.equal(first.store, false);
const wire = JSON.stringify(first);
assert.equal(JSON.stringify(request()), wire);
const wireSha256 = createHash("sha256").update(wire).digest("hex");
for (let i = 0; i < 50; i++) {
  request();
}
globalThis.gc?.();
const retainedWarm = process.memoryUsage();
const gcEntries: { kind: number; ms: number }[] = [];
let started = Infinity;
let finished = Infinity;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime >= started && entry.startTime < finished) {
      const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      gcEntries.push({ kind: detail.kind, ms: entry.duration });
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = new Session();
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 8192,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpu = process.cpuUsage();
const threadCpu = process.threadCpuUsage();
const start = performance.now();
started = start;
for (let i = 0; i < iterations; i++) {
  request();
}
finished = performance.now();
const wallMs = finished - start;
const mainThreadUsed = process.threadCpuUsage(threadCpu);
const used = process.cpuUsage(cpu);
let sampledBytes: number | undefined;
if (allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: typeof profile.head): number =>
    node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
await nextTurn();
await nextTurn();
observer.disconnect();
const memoryBeforeFinalGc = process.memoryUsage();
globalThis.gc?.();
const retainedAfter = process.memoryUsage();
console.log(
  JSON.stringify({
    iterations,
    messages: messages.length,
    frozen,
    hook,
    conversionOnly,
    images: messages.filter(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "image"),
    ).length,
    imageBytes: imageBytes.length,
    wireSha256,
    mode: allocation ? "allocation" : "timing",
    cpuUsPerRequest: (used.user + used.system) / iterations,
    mainThreadCpuUsPerRequest: (mainThreadUsed.user + mainThreadUsed.system) / iterations,
    wallUsPerRequest: (wallMs * 1000) / iterations,
    wallMs,
    gc: {
      count: gcEntries.length,
      totalMs: gcEntries.reduce((sum, entry) => sum + entry.ms, 0),
      maxMs: Math.max(0, ...gcEntries.map((entry) => entry.ms)),
      byKind: [1, 4, 8].map((kind) => ({
        kind,
        count: gcEntries.filter((entry) => entry.kind === kind).length,
        ms: gcEntries
          .filter((entry) => entry.kind === kind)
          .reduce((sum, entry) => sum + entry.ms, 0),
      })),
    },
    retainedWarmHeapBytes: retainedWarm.heapUsed - retainedBefore.heapUsed,
    retainedFinalHeapBytes: retainedAfter.heapUsed - retainedBefore.heapUsed,
    memoryBeforeFinalGc,
    hostLoadBefore,
    sampledBytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    hostLoad: loadavg(),
    memory: process.memoryUsage(),
  }),
);
