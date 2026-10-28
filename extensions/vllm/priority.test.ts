import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, expect, it } from "vitest";
import vllmPlugin from "./index.js";

const originalHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(originalHost));

type RequestModel = Partial<Model<"openai-completions">>;

async function captureRequest(
  context: Partial<ProviderWrapStreamFnContext>,
  requestModel: RequestModel = {},
  simple = false,
  explicitPriority?: number,
) {
  let captured: Record<string, unknown> | undefined;
  configureAiTransportHost({
    ...originalHost,
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://vllm.example/v1/chat/completions");
      captured = await request.json();
      return new Response(
        'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const plugin = await registerSingleProviderPlugin(vllmPlugin);
  const model: Model<"openai-completions"> = {
    id: "small-model",
    name: "Small model",
    provider: context.provider ?? "vllm",
    api: "openai-completions",
    baseUrl: "https://vllm.example/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const base = createOpenAICompletionsTransportStreamFn();
  const wrap = simple ? plugin.wrapSimpleCompletionStreamFn : plugin.wrapStreamFn;
  const { provider, id: modelId, api: sourceApi } = model;
  const streamFn =
    wrap?.({ provider, modelId, model, sourceApi, streamFn: base, ...context }) ?? base;
  const stream = await streamFn(
    { ...model, ...requestModel },
    { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] },
    {
      apiKey: "synthetic-fixture",
      maxTokens: 8,
      onPayload: async (payload) => ({
        ...asOptionalObjectRecord(payload),
        temperature: 0.25,
        ...(explicitPriority !== undefined ? { priority: explicitPriority } : {}),
      }),
    },
  );
  const result = await stream.result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(captured).toMatchObject({ temperature: 0.25 });
  expect(captured).not.toHaveProperty("priorityScheduling");
  return captured;
}

it.each([0, -25, 75])("preserves static priority %s without opt-in", async (priority) => {
  expect(await captureRequest({}, {}, false, priority)).toHaveProperty("priority", priority);
});

it.each([
  ["foreground", -100],
  ["normal", 0],
  ["background", 100],
] as const)("sends %s priority %s through both provider hooks", async (urgency, priority) => {
  const context = { modelParams: { priorityScheduling: true }, modelCallUrgency: urgency };
  for (const simple of [false, true]) {
    expect(await captureRequest(context, {}, simple, 0)).toHaveProperty("priority", priority);
  }
});

it.each<[Partial<ProviderWrapStreamFnContext>, RequestModel]>([
  [{ modelParams: { priorityScheduling: undefined } }, {}],
  [{ modelParams: { priorityScheduling: false } }, {}],
  [{ modelParams: { priorityScheduling: true }, provider: "other" }, {}],
  [{ modelParams: { priorityScheduling: true } }, { provider: "other" }],
  [{ modelParams: { priorityScheduling: true } }, { id: "fallback" }],
  [{ extraParams: { priorityScheduling: true } }, {}],
])("leaves priority absent for context %j and request %j", async (context, request) => {
  expect(await captureRequest(context, request)).not.toHaveProperty("priority");
});
