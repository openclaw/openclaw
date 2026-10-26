/** Real iterator installers for agent-stream-update-measure.ts --layer. */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { makeAssistantMessage } from "../../packages/agent-core/src/agent-loop.test-support.js";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import type { AssistantMessageEvent } from "../../packages/llm-core/src/types.js";
import type { MutableAssistantMessageEventStream } from "../../src/agents/stream-compat.js";

type Layer = (events: number) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
const model = makeProviderModel("openai-responses", "openai", "fixture-model");
const message = { ...makeAssistantMessage([{ type: "text", text: "x" }]), timestamp: 1 };
const update: AssistantMessageEvent = {
  type: "text_delta",
  contentIndex: 0,
  delta: "x",
  partial: message,
};
const rawEvent = { type: "response.output_text.delta", delta: "x" };
const responsesRecording = [
  { type: "response.created", response: { id: "fixture-response", model: model.id } },
  { type: "response.output_item.added", item: { type: "message", id: "fixture-message" } },
  { type: "response.reasoning_summary_text.delta", delta: "inspect" },
  rawEvent,
  { type: "response.function_call_arguments.delta", delta: '{"path":' },
  { type: "response.function_call_arguments.delta", delta: '"fixture"}' },
  {
    type: "response.output_item.done",
    item: { type: "function_call", name: "read", arguments: '{"path":"fixture"}' },
  },
  {
    type: "response.completed",
    response: {
      id: "fixture-response",
      model: model.id,
      service_tier: "default",
      usage: { output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } },
    },
  },
];

function replay<T>(count: number, value: T): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let remaining = count;
      return {
        next: () =>
          Promise.resolve(
            remaining-- > 0
              ? { done: false as const, value }
              : { done: true as const, value: undefined },
          ),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      };
    },
  };
}

function assistant(count: number): MutableAssistantMessageEventStream {
  return { ...replay(count, update), result: () => Promise.resolve(message) };
}

async function installers(verify: boolean): Promise<Record<string, Layer>> {
  const [
    { observeResponsesStream },
    { createResponseModelTracker },
    { createResponsesV2CompactionCollector },
    { withProviderResponseHook, iterateModelStream },
    { withResponsesRequestAcceptance },
    { withFirstStreamEventTimeout },
    { EventStream, bindAssistantMessageEventStream },
    { admitProviderRateLimitStream },
    { wrapStreamFnPromoteStandaloneTextToolCalls },
    { wrapStreamFnTextTransforms },
    { streamWithIdleTimeout },
    { default: OpenAI },
    { createResponsesStreamWithRecovery },
  ] = await Promise.all([
    import("../../packages/ai/src/transports/openai-responses-stream-observer-internal.js"),
    import("../../packages/ai/src/transports/openai-transport-shared.js"),
    import("../../packages/ai/src/transports/openai-responses-compaction-v2.js"),
    import("../../packages/ai/src/transports/transport-stream-shared.js"),
    import("../../packages/ai/src/transports/openai-responses-request-lifecycle.js"),
    import("../../packages/ai/src/utils/stream-first-event-timeout.js"),
    import("../../packages/llm-core/src/utils/event-stream.js"),
    import("../../src/llm/provider-rate-limit-stream.js"),
    import("../../src/agents/embedded-agent-runner/run/attempt-tool-call-text-promotion.js"),
    import("../../src/agents/plugin-text-transforms.js"),
    import("../../src/agents/embedded-agent-runner/run/llm-idle-timeout.js"),
    import("openai"),
    import("../../packages/ai/src/transports/openai-responses-replay-internal.js"),
  ]);
  const context = { messages: [] };
  const observerSource = (count: number): AsyncIterable<unknown> => {
    if (!verify) {
      return replay(count, rawEvent);
    }
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: () =>
            Promise.resolve(
              index < count
                ? {
                    done: false as const,
                    value: responsesRecording[index++ % responsesRecording.length],
                  }
                : { done: true as const, value: undefined },
            ),
        };
      },
    };
  };
  return {
    source: (count) => replay(count, rawEvent),
    "responses-observer": (count) => observeResponsesStream(observerSource(count), model),
    "response-model": (count) =>
      createResponseModelTracker().track(undefined, replay(count, rawEvent)),
    "compaction-v2": (count) =>
      createResponsesV2CompactionCollector().observe(replay(count, rawEvent)),
    "provider-hook": (count) => {
      const controller = new AbortController();
      return withProviderResponseHook({
        stream: replay(count, rawEvent),
        signal: controller.signal,
        abort: (error) => controller.abort(error),
      });
    },
    acceptance: (count) =>
      withResponsesRequestAcceptance(replay(count, rawEvent), {
        beforeDispatch: async () => {},
        assertCurrent() {},
        accepted: async () => {},
        settle: async () => {},
      }),
    "first-event": (count) =>
      withFirstStreamEventTimeout(replay(count, rawEvent), { timeoutMs: 60_000 }),
    scheduling: (count) => iterateModelStream(replay(count, rawEvent)),
    "event-queue": (count) => {
      const stream = new EventStream<unknown>(
        () => false,
        (event) => event,
      );
      for (let index = 0; index < count; index++) {
        stream.push(rawEvent);
      }
      stream.end(rawEvent);
      return stream;
    },
    "event-waiter": (count) => {
      const stream = new EventStream<unknown>(
        () => false,
        (event) => event,
      );
      return {
        [Symbol.asyncIterator]() {
          const iterator = stream[Symbol.asyncIterator]();
          let remaining = count;
          return {
            next() {
              if (remaining-- <= 0) {
                stream.end(rawEvent);
              }
              const pending = iterator.next();
              if (remaining >= 0) {
                queueMicrotask(() => stream.push(rawEvent));
              }
              return pending;
            },
          };
        },
      };
    },
    binding: (count) =>
      bindAssistantMessageEventStream({ ...assistant(count), push() {}, end() {} }, (run) => run()),
    "rate-limit": (count) =>
      admitProviderRateLimitStream(model, { apiKey: "synthetic-probe-key" }, () =>
        assistant(count),
      ),
    promotion: (count) =>
      wrapStreamFnPromoteStandaloneTextToolCalls(() => assistant(count), new Set(["read"]))(
        model,
        context,
      ),
    "plugin-text": (count) =>
      wrapStreamFnTextTransforms({
        streamFn: () => assistant(count),
        output: [{ from: "never-matches", to: "replacement" }],
      })(model, context),
    idle: (count) => streamWithIdleTimeout(() => assistant(count), 60_000)(model, context),
    // These three private owners are exercised together through their public
    // transport entry point; its slope includes SDK SSE parsing and body reads.
    "responses-sse": async (count) => {
      const data = `data: ${JSON.stringify(rawEvent)}\n\n`.repeat(count);
      const client = new OpenAI({
        apiKey: "synthetic-probe-key",
        maxRetries: 0,
        fetch: async () => new Response(data, { headers: { "content-type": "text/event-stream" } }),
      });
      const request = {
        model: model.id,
        stream: true as const,
        input: [{ role: "user" as const, content: "synthetic" }],
      };
      return (
        await createResponsesStreamWithRecovery({
          client,
          model,
          request,
          requestOptions: undefined,
          buildFullHistoryRequest: () => request,
        })
      ).stream;
    },
  };
}

async function consume(layer: Layer, events: number, record?: ReturnType<typeof createHash>) {
  let count = 0;
  for await (const event of await layer(events)) {
    count++;
    record?.update(JSON.stringify(event));
  }
  assert.equal(count, events);
}

async function countPromises(layer: Layer, events: number) {
  let promises = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "PROMISE") {
        promises++;
      }
    },
  });
  hook.enable();
  try {
    await consume(layer, events);
  } finally {
    hook.disable();
  }
  return promises;
}

export async function measureStreamLayers(options: {
  layer: string;
  mode: string;
  events: number;
  turns: number;
  warmup: number;
  profile?: string;
}) {
  const layers = await installers(options.mode === "verify");
  const names = options.layer === "all" ? Object.keys(layers) : [options.layer];
  assert(
    options.layer !== "all" || options.mode === "promises",
    "all layers supports promises mode only",
  );
  const small = 32;
  assert(options.events > small, "layer measurement requires --events > 32");
  for (const name of names) {
    const layer = layers[name];
    assert(layer, `unknown layer ${name}; available: ${Object.keys(layers).join(", ")}`);
    for (let index = 0; index < options.warmup; index++) {
      await consume(layer, options.events);
    }
    if (options.mode === "promises") {
      const smallPromises = await countPromises(layer, small);
      const largePromises = await countPromises(layer, options.events);
      console.log(
        JSON.stringify({
          layer: name,
          mode: options.mode,
          smallEvents: small,
          largeEvents: options.events,
          smallPromises,
          largePromises,
          promisesPerEvent: (largePromises - smallPromises) / (options.events - small),
          note:
            name === "responses-sse"
              ? "terminal drain + provider attribution + recovery + SDK/body; not isolated layer costs"
              : undefined,
        }),
      );
      continue;
    }
    if (options.mode === "verify") {
      const hash = createHash("sha256");
      await consume(layer, options.events, hash);
      console.log(
        JSON.stringify({
          layer: name,
          mode: options.mode,
          events: options.events,
          outputSha256: hash.digest("hex"),
        }),
      );
      continue;
    }
    globalThis.gc?.();
    const allocation = options.mode === "allocation";
    const session = new Session();
    if (allocation) {
      session.connect();
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let index = 0; index < options.turns; index++) {
      await consume(layer, options.events);
    }
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    let allocatedBytes: number | undefined;
    if (allocation) {
      const { profile } = await session.post("HeapProfiler.stopSampling");
      session.disconnect();
      if (options.profile) {
        writeFileSync(options.profile, JSON.stringify(profile));
      }
      const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      allocatedBytes = sum(profile.head);
    }
    const deliveries = options.events * options.turns;
    console.log(
      JSON.stringify({
        layer: name,
        mode: options.mode,
        events: options.events,
        turns: options.turns,
        warmup: options.warmup,
        deliveries,
        hostLoad,
        elapsedMs,
        cpuNsPerUpdate: ((used.user + used.system) * 1000) / deliveries,
        allocatedBytesPerUpdate:
          allocatedBytes === undefined ? undefined : allocatedBytes / deliveries,
      }),
    );
  }
}
