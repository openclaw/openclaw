/**
 * Measure the real Responses SSE transport against a synthetic upstream.
 * node --import ./scripts/tsx.mjs scripts/perf/responses-prefix-checkpoint-measure.ts
 * Use --baseline with the original converter source and run each mode in a fresh process.
 * Compare five counterbalanced A/B and A/A pairs. Expect identical wire and persisted hashes,
 * zero historical encodes on stable input, and lower prefix CPU and allocation beyond A/A spread.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { Context } from "@openclaw/llm-core";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { readResponsesInputReplayState } from "../../packages/ai/src/transports/openai-responses-input-replay.js";
import * as fixtures from "../../packages/ai/src/transports/openai-responses-prompt-observer.test-support.js";
import { prepareSystemPrompt } from "../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import { transformTransportMessages } from "../../src/agents/transport-message-transform.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.js";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "200" },
  },
});
const { mode } = values;
assert(["timing", "allocation", "cpu", "count"].includes(mode));
const turns = Number(values.turns);
const replaced = registerPerfOwnerReplacement(
  new URL(
    "../../packages/ai/src/transports/openai-responses-replay-messages-internal.ts",
    import.meta.url,
  ).href,
  values.baseline,
);
const { createOpenAIResponsesTransportStreamFn } =
  await import("../../packages/ai/src/transports/openai-responses-client.js");
assert.equal(replaced(), Boolean(values.baseline));

const model = fixtures.createModel({
  reasoning: true,
  compat: { cachesInstructions: false },
});
const identity = { sessionId: "synthetic-prefix-checkpoint" };
const checkpoint = fixtures.createAssistant(model);
captureOpenAIResponsesCompaction(
  checkpoint,
  { type: "compaction", id: "cmp_perf", encrypted_content: "synthetic-checkpoint" },
  0,
  model,
  buildOpenAIResponsesReasoningReplayMetadata(model, identity),
);
const systemPrompt = "Follow the synthetic lookup instructions. ".repeat(300);
const context: Context = {
  systemPrompt,
  preparedSystemPrompt: prepareSystemPrompt(systemPrompt),
  messages: [
    freezeJsonSnapshot(checkpoint),
    freezeJsonSnapshot(fixtures.userMessage("Start lookup.")),
  ],
  tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object" } }],
};
const responses = Array.from({ length: turns }, (_, index) => {
  const output = [
    {
      type: "reasoning",
      id: `rs_${index}`,
      summary: [],
      encrypted_content: "r".repeat(4096) + index,
    },
    {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name: "lookup",
      arguments: "{}",
      status: "completed",
    },
  ];
  return [
    ...output.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    fixtures.completedResponse(`resp_${index}`, output, { usage: fixtures.responseUsage }),
  ];
});

let sent = 0;
let maxInputItems = 0;
const wire = createHash("sha256");
const persisted = createHash("sha256");
configureAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
  transformTransportMessages,
  buildModelFetch: () => async (_input, init) => {
    const request = await fixtures.requestBody(init);
    assert.equal(request.instructions, undefined);
    assert.ok(Array.isArray(request.input));
    maxInputItems = Math.max(maxInputItems, request.input.length);
    wire.update(JSON.stringify(request)).update("\n");
    const events = responses[sent++];
    assert(events, "Unexpected provider request");
    return fixtures.sseResponse(events);
  },
});

const profile = new Session();
profile.connect();
if (mode === "allocation") {
  await profile.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
} else if (mode === "cpu") {
  await profile.post("Profiler.enable");
  await profile.post("Profiler.setSamplingInterval", { interval: 100 });
  await profile.post("Profiler.start");
}
const stringify = JSON.stringify;
let encodes = 0;
let historicalEncodes = 0;
if (mode === "count") {
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    if (typeof value === "string" && value.startsWith("tool-output/")) {
      const stack = new Error().stack ?? "";
      if (stack.includes("appendPrefixValues")) {
        encodes++;
        if (Number(value.split("/", 3)[1]) < sent - 2) {
          historicalEncodes++;
        }
      }
    }
    return Reflect.apply(stringify, JSON, [value, ...args]);
  }) as typeof JSON.stringify;
}
const stream = createOpenAIResponsesTransportStreamFn();
const started = performance.now();
const startCpu = process.threadCpuUsage();
const latencies: number[] = [];
try {
  for (let turn = 0; turn < turns; turn++) {
    const start = performance.now();
    const result = await (
      await stream(model, context, {
        ...identity,
        apiKey: "synthetic-key",
        transport: "sse",
      })
    ).result();
    latencies.push(performance.now() - start);
    assert.equal(result.stopReason, "toolUse", result.errorMessage ?? "Expected a tool call");
    const usage = readResponsesInputReplayState(result)?.contextUsage;
    assert(usage && typeof usage === "object" && "prefixHash" in usage);
    assert(typeof usage.prefixHash === "string");
    persisted.update(usage.prefixHash);
    context.messages.push(
      freezeJsonSnapshot(result),
      freezeJsonSnapshot(
        makeTextToolResult(
          `call_${turn}|fc_${turn}`,
          "lookup",
          `tool-output/${turn}/${"t".repeat(16384)}`,
          false,
          turn + 2,
        ),
      ),
    );
  }
} finally {
  JSON.stringify = stringify;
  cleanupSessionResources(identity.sessionId);
}
const wall = performance.now() - started;
const cpu = process.threadCpuUsage(startCpu);
const isOwner = (name: string) => name === "recordResponsesContextUsage";
const isPrefix = (name: string) => name === "responsesContinuationPrefixFingerprint";
let allAllocated = 0;
let ownerMetric = 0;
let prefixMetric = 0;
if (mode === "allocation") {
  const { profile: sample } = await profile.post("HeapProfiler.stopSampling");
  const visit = (node: typeof sample.head, parentHasOwner = false, parentHasPrefix = false) => {
    const owner = parentHasOwner || isOwner(node.callFrame.functionName);
    const prefix = parentHasPrefix || isPrefix(node.callFrame.functionName);
    allAllocated += node.selfSize;
    if (owner) {
      ownerMetric += node.selfSize;
    }
    if (prefix) {
      prefixMetric += node.selfSize;
    }
    for (const child of node.children) {
      visit(child, owner, prefix);
    }
  };
  visit(sample.head);
} else if (mode === "cpu") {
  const { profile: sample } = await profile.post("Profiler.stop");
  const nodes = new Map(sample.nodes.map((node) => [node.id, node]));
  const parents = new Map(
    sample.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id] as const)),
  );
  for (const [index, id] of (sample.samples ?? []).entries()) {
    const elapsed = sample.timeDeltas?.[index] ?? 0;
    let owner = false;
    let prefix = false;
    for (
      let current: number | undefined = id;
      current !== undefined;
      current = parents.get(current)
    ) {
      const name = nodes.get(current)?.callFrame.functionName ?? "";
      owner ||= isOwner(name);
      prefix ||= isPrefix(name);
    }
    if (owner) {
      ownerMetric += elapsed;
    }
    if (prefix) {
      prefixMetric += elapsed;
    }
  }
}
profile.disconnect();
assert.equal(sent, turns);
console.log(
  JSON.stringify({
    mode,
    turns,
    sent,
    maxInputItems,
    encodes,
    historicalEncodes,
    wireHash: wire.digest("hex"),
    persistedHash: persisted.digest("hex"),
    cpuUsPerResponse: (cpu.user + cpu.system) / turns,
    wallMsPerResponse: wall / turns,
    p95Ms: latencies.toSorted((a, b) => a - b)[Math.ceil(turns * 0.95) - 1],
    allocationBytesPerResponse: allAllocated / turns,
    contextUsagePerResponse: ownerMetric / turns,
    prefixPerResponse: prefixMetric / turns,
    load: loadavg(),
  }),
);
