// Measure native rate-limit stream admission, including 25% synthetic 429 responses.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-rate-limit-stream-measure.ts \
//   --scenario unkeyed --mode timing --turns 3000 --chunks 64
// Scenarios: unkeyed, inherited, active, delegated. Modes: timing, allocation (separate passes).
// --error-percent 0 or 25 compares successful traffic with injected 429s.
// Run unchanged on both revisions in AB/BA order. Allocation includes collected objects;
// timing uses main-thread CPU. This is owner proof, not whole-Gateway throughput.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { admitProviderRateLimitStream } from "../../src/llm/provider-rate-limit-stream.ts";
import { createProviderRateLimitRequest } from "../../src/llm/provider-rate-limit.ts";
import type { AssistantMessage, Model } from "../../src/llm/types.ts";
import { createAssistantMessageEventStream } from "../../src/llm/utils/event-stream.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "unkeyed" },
    mode: { type: "string", default: "timing" },
    turns: { type: "string", default: "3000" },
    chunks: { type: "string", default: "64" },
    "error-percent": { type: "string", default: "25" },
  },
});
const turns = Number(values.turns);
const chunks = Number(values.chunks);
const errorPercent = Number(values["error-percent"]);
assert(errorPercent === 0 || errorPercent === 25);
assert(Number.isSafeInteger(turns) && turns > 0);
assert(Number.isSafeInteger(chunks) && chunks > 0);
assert(["unkeyed", "inherited", "active", "delegated"].includes(values.scenario));
assert(["timing", "allocation"].includes(values.mode));
const model: Model = {
  id: "synthetic",
  name: "Synthetic",
  provider: "synthetic",
  api: "openai-responses",
  baseUrl: "https://synthetic.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const message: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "synthetic" }],
  stopReason: "stop",
  timestamp: 0,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
let sequence = 0;
async function run(count: number) {
  let events = 0;
  let failures = 0;
  for (let turn = 0; turn < count; turn++) {
    const index = sequence++;
    const keyed = {
      apiKey: `synthetic-${index}`,
      sessionId: `agent:synthetic:subagent:${index}`,
      maxTokens: 4096,
      temperature: 0.7,
      reasoning: "medium" as const,
      maxRetryDelayMs: 60000,
      headers: { "x-request-id": `synthetic-${index}` },
      onPayload: () => {},
    };
    const options =
      values.scenario === "unkeyed"
        ? {}
        : values.scenario === "inherited"
          ? createProviderRateLimitRequest(model, keyed).options
          : keyed;
    const failed = errorPercent === 25 && index % 4 === 0;
    const terminal: AssistantMessage = failed
      ? {
          ...message,
          stopReason: "error",
          retryAfterMs: 60000,
          errorMessage: `429 Rate limit reached in organization org-synthetic-${index} on tokens per min (TPM).`,
        }
      : message;
    const source = createAssistantMessageEventStream();
    for (let chunk = 0; chunk < chunks; chunk++) {
      source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: message });
    }
    source.push(
      failed
        ? { type: "error", reason: "error", error: terminal }
        : { type: "done", reason: "stop", message: terminal },
    );
    source.end();
    const stream = await admitProviderRateLimitStream(model, options, (admitted) =>
      values.scenario === "delegated"
        ? admitProviderRateLimitStream(model, admitted, () => source)
        : source,
    );
    for await (const event of stream) {
      events++;
      if (event.type === "error") {
        failures++;
      }
    }
    assert.equal(await stream.result(), terminal);
    if (failed && (values.scenario === "active" || values.scenario === "delegated")) {
      await assert.rejects(
        admitProviderRateLimitStream(model, { ...keyed, maxRetryDelayMs: 1 }, () =>
          assert.fail("429 must gate the next request"),
        ),
        { status: 429 },
      );
    }
  }
  assert.equal(events, count * (chunks + 1));
  return { events, failures };
}
await run(200);
globalThis.gc?.();
const session = new Session();
if (values.mode === "allocation") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 8192,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const before = process.threadCpuUsage();
const start = performance.now();
const counts = await run(turns);
const wallMs = performance.now() - start;
const cpu = process.threadCpuUsage(before);
let allocatedBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  session.disconnect();
}
console.log(
  JSON.stringify({
    scenario: values.scenario,
    mode: values.mode,
    turns,
    chunks,
    errorPercent,
    ...counts,
    wallMs,
    cpuUsPerTurn: (cpu.user + cpu.system) / turns,
    allocatedBytesPerTurn: allocatedBytes === undefined ? undefined : allocatedBytes / turns,
    hostLoad,
    memory: process.memoryUsage(),
    node: process.version,
  }),
);
