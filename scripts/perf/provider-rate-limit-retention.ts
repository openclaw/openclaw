// Admission lifetime probe with real native streams and synthetic callbacks.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-rate-limit-retention.ts
// Optional: --turns 156 --payload-bytes 32768. Run unchanged on both revisions.
// Forced-GC heap deltas are context; weak references count retained fixture bytes.
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { admitProviderRateLimitStream } from "../../src/llm/provider-rate-limit-stream.ts";
import type { AssistantMessage, Model } from "../../src/llm/types.ts";
import { createAssistantMessageEventStream } from "../../src/llm/utils/event-stream.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "156" },
    "payload-bytes": { type: "string", default: "32768" },
  },
});
const turns = Number(values.turns);
const payloadBytes = Number(values["payload-bytes"]);
assert(Number.isSafeInteger(turns) && turns > 0);
assert(Number.isSafeInteger(payloadBytes) && payloadBytes > 0 && payloadBytes % 8 === 0);
const gc = globalThis.gc;
assert(gc, "Run with --expose-gc");
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
  content: [],
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
async function settledHeap() {
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 6; pass++) {
    await nextTurn();
    gc!();
  }
  assert.equal(control.deref(), undefined);
  return process.memoryUsage();
}
async function admit(index: number) {
  const payload = Array.from({ length: payloadBytes / 8 }, () => index);
  const source = createAssistantMessageEventStream();
  const stream = await admitProviderRateLimitStream(
    model,
    {
      apiKey: `synthetic-${index}`,
      headers: { "openai-organization": `org-synthetic-${index}` },
      onPayload: () => payload,
    },
    () => source,
  );
  return { source, stream, reference: new WeakRef(payload) };
}
const before = await settledHeap();
const held = [];
for (let index = 0; index < turns; index++) {
  const entry = await admit(index);
  const mode = index % 4;
  const terminal: AssistantMessage =
    mode === 1 || mode === 2
      ? {
          ...message,
          stopReason: "error",
          retryAfterMs: 1,
          errorMessage: `429 Rate limit reached in organization org-synthetic-${index} on tokens per min (TPM). Retry-After: 0.001 seconds.`,
        }
      : message;
  if (mode !== 3) {
    entry.source.push(
      terminal.stopReason === "error"
        ? { type: "error", reason: "error", error: terminal }
        : { type: "done", reason: "stop", message: terminal },
    );
  }
  entry.source.end();
  if (mode === 3) {
    await assert.rejects(entry.stream.result(), /without a terminal event/);
  } else {
    if (mode !== 2) {
      for await (const event of entry.stream) {
        assert.equal(event.type, mode === 0 ? "done" : "error");
      }
    }
    if (mode !== 0) {
      assert.equal(await entry.stream.result(), terminal);
    }
  }
  held.push({ ...entry, terminal });
}
const after = await settledHeap();
const retained = held.filter(({ reference }) => reference.deref()).length;
for (const [index, entry] of held.entries()) {
  if (index % 4 !== 3) {
    assert.equal(await entry.stream.result(), entry.terminal);
  }
}
console.log(
  JSON.stringify({
    protocol: "provider-rate-limit-retention-v1",
    node: process.version,
    turns,
    payloadBytes,
    retainedCallbacks: retained,
    retainedPayloadBytes: retained * payloadBytes,
    before,
    after,
    settledHeapDelta: after.heapUsed - before.heapUsed,
    scope:
      "Admission owner/native stream; held completed streams, normalized 429 retry evidence, rejected results. No Gateway or HTTP transport.",
  }),
);
