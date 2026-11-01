// Admission lifetime probe with real native streams and synthetic callbacks.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-rate-limit-retention.ts
// Optional: --turns 1100 --payload-bytes 32768 (100 turns per lifecycle scenario).
// Run unchanged on both revisions; late result reads still prove 429 admission.
// Forced-GC heap deltas are context; weak references count retained fixture bytes.
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { withModelTransportContext } from "../../src/llm/model-transport-context.ts";
import { admitProviderRateLimitStream } from "../../src/llm/provider-rate-limit-stream.ts";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../../src/llm/types.ts";
import { createAssistantMessageEventStream } from "../../src/llm/utils/event-stream.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "1100" },
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
const scenarios = [
  "success",
  "consumed-429",
  "result-only-429",
  "rejected-result",
  "aborted-iterator",
  "unread-success",
  "bare-end",
  "abandoned-429",
  "queued-abort",
  "429-retry",
  "completed-429-context",
] as const;
function rateLimit(index: number, retryAfterMs: number): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    retryAfterMs,
    errorMessage: `429 Rate limit reached in organization org-synthetic-${index} on tokens per min (TPM).`,
  };
}
async function admit(index: number) {
  const mode = index % scenarios.length;
  if (mode === 10) {
    return {
      mode,
      reference: await completedRateLimitContext(index),
      stream: undefined,
      retry: undefined,
      terminal: message,
    };
  }
  const payload = Array.from({ length: payloadBytes / 8 }, () => index);
  const source = createAssistantMessageEventStream();
  const controller = new AbortController();
  const options: SimpleStreamOptions = {
    apiKey: `synthetic-${index}`,
    headers: { "openai-organization": `org-synthetic-${index}` },
    signal: controller.signal,
    onPayload: () => payload,
  };
  const stream = await admitProviderRateLimitStream(model, options, () => source);
  const terminal =
    mode === 1 || mode === 2 || mode >= 7
      ? rateLimit(index, mode === 7 || mode === 8 ? 60_000 : 1)
      : mode === 4
        ? { ...message, stopReason: "aborted" as const }
        : message;
  if (mode === 4 || mode === 7) {
    source.push({ type: "start", partial: message });
    for await (const event of stream) {
      assert.equal(event.type, "start");
      break;
    }
    if (mode === 4) {
      controller.abort("synthetic stop");
    }
  }
  if (mode !== 3 && mode !== 6) {
    source.push(
      terminal.stopReason === "error" || terminal.stopReason === "aborted"
        ? { type: "error", reason: terminal.stopReason, error: terminal }
        : { type: "done", reason: "stop", message: terminal },
    );
  }
  source.end();
  if (mode === 3) {
    await assert.rejects(stream.result(), /without a terminal event/);
  } else if (mode === 0 || mode === 1 || mode === 6) {
    for await (const event of stream) {
      assert.equal(event.type, mode === 0 ? "done" : "error");
    }
  } else if (mode === 2 || mode === 8 || mode === 9) {
    assert.equal(await stream.result(), terminal);
  }
  let retry;
  if (mode === 8) {
    const pending = admitProviderRateLimitStream(model, { ...options, maxRetryDelayMs: 0 }, () => {
      assert.fail("Aborted admission must not start a provider request");
    });
    const rejected = assert.rejects(pending, (error) => error === "synthetic queued stop");
    controller.abort("synthetic queued stop");
    await rejected;
  } else if (mode === 9) {
    retry = await admitProviderRateLimitStream(model, options, () => {
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: "stop", message });
      output.end();
      return output;
    });
    assert.equal(await retry.result(), message);
  }
  return { stream, retry, terminal, mode, reference: new WeakRef(payload) };
}
async function completedRateLimitContext(index: number) {
  const payload = Array.from({ length: payloadBytes / 8 }, () => index);
  await withModelTransportContext(
    {
      requestId: `synthetic-${index}`,
      onRateLimitWait: () => () => {
        void payload.length;
      },
    },
    async () => {
      const output = await admitProviderRateLimitStream(
        model,
        { apiKey: `synthetic-${index}` },
        () => {
          const source = createAssistantMessageEventStream();
          source.push({ type: "error", reason: "error", error: rateLimit(index, 1) });
          source.end();
          return source;
        },
      );
      for await (const event of output) {
        assert.equal(event.type, "error");
      }
      assert.equal((await output.result()).stopReason, "error");
    },
  );
  // No stream handle remains; only the shared gate's recovery timer survives.
  return new WeakRef(payload);
}
const before = await settledHeap();
const held: Awaited<ReturnType<typeof admit>>[] = [];
for (let index = 0; index < turns; index++) {
  const entry = await admit(index);
  held.push(entry);
}
const after = await settledHeap();
const retained = held.filter(({ reference }) => reference.deref()).length;
const perScenario = scenarios.map((scenario, mode) => {
  const entries = held.filter((entry) => entry.mode === mode);
  const count = entries.filter(({ reference }) => reference.deref()).length;
  return {
    scenario,
    turns: entries.length,
    retainedCallbacks: count,
    retainedPayloadBytes: count * payloadBytes,
  };
});
for (const [index, entry] of held.entries()) {
  if (!entry.stream) {
    continue;
  }
  if (entry.mode === 3 || entry.mode === 6) {
    await assert.rejects(entry.stream.result(), /without a terminal event/);
  } else {
    assert.equal(await entry.stream.result(), entry.terminal);
  }
  if (entry.mode === 7) {
    // Closing iteration must not discard a 429 observed by a later result reader.
    await assert.rejects(
      admitProviderRateLimitStream(
        model,
        {
          apiKey: `synthetic-${index}`,
          headers: { "openai-organization": `org-synthetic-${index}` },
          maxRetryDelayMs: 1,
        },
        () => assert.fail("The deferred 429 must still gate the next request"),
      ),
      { status: 429, reason: "rate_limit" },
    );
  }
}
console.log(
  JSON.stringify({
    protocol: "provider-rate-limit-retention-v2",
    node: process.version,
    turns,
    payloadBytes,
    retainedCallbacks: retained,
    retainedPayloadBytes: retained * payloadBytes,
    perScenario,
    before,
    after,
    settledHeapDelta: after.heapUsed - before.heapUsed,
    scope:
      "Admission/native streams; success, 429 retries, queued and early-consumer aborts, producer-only completion, rejected results. No Gateway or HTTP transport.",
  }),
);
