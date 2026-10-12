import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it } from "vitest";
import vllmPlugin from "./index.js";

const originalHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(originalHost));

async function captureRequest(params: {
  modelParams?: Record<string, unknown>;
  extraParams?: Record<string, unknown>;
  urgency?: ProviderWrapStreamFnContext["modelCallUrgency"];
  simple?: boolean;
  provider?: string;
  requestProvider?: string;
  requestModelId?: string;
  explicitPriority?: number;
}) {
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
    provider: params.provider ?? "vllm",
    api: "openai-completions",
    baseUrl: "https://vllm.example/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const base = createOpenAICompletionsTransportStreamFn();
  const wrap = params.simple ? plugin.wrapSimpleCompletionStreamFn : plugin.wrapStreamFn;
  const streamFn =
    wrap?.({
      provider: model.provider,
      modelId: model.id,
      model,
      sourceApi: model.api,
      streamFn: base,
      modelParams: params.modelParams,
      extraParams: params.extraParams,
      modelCallUrgency: params.urgency,
    }) ?? base;
  const stream = await streamFn(
    {
      ...model,
      provider: params.requestProvider ?? model.provider,
      id: params.requestModelId ?? model.id,
    },
    { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] },
    {
      apiKey: "synthetic-fixture",
      maxTokens: 8,
      onPayload: async (payload) => ({
        ...asOptionalObjectRecord(payload),
        temperature: 0.25,
        ...(params.explicitPriority !== undefined ? { priority: params.explicitPriority } : {}),
      }),
    },
  );
  const result = await stream.result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(captured).toMatchObject({ temperature: 0.25 });
  expect(captured).not.toHaveProperty("priorityScheduling");
  return captured;
}

describe("vLLM native priority wire contract", () => {
  it.each([undefined, false])("adds no priority when scheduling is %s", async (enabled) => {
    expect(
      await captureRequest({ modelParams: { priorityScheduling: enabled } }),
    ).not.toHaveProperty("priority");
  });

  it.each([0, -25, 75])(
    "preserves the explicit static priority %s without opt-in",
    async (priority) => {
      expect(await captureRequest({ explicitPriority: priority })).toHaveProperty(
        "priority",
        priority,
      );
    },
  );

  it.each([
    ["foreground", -100],
    ["normal", 0],
    ["background", 100],
  ] as const)("sends %s priority %s through both provider hooks", async (urgency, priority) => {
    for (const simple of [false, true]) {
      expect(
        await captureRequest({
          modelParams: { priorityScheduling: true },
          urgency,
          simple,
          explicitPriority: 0,
        }),
      ).toHaveProperty("priority", priority);
    }
  });

  it.each([
    { provider: "other" },
    { requestProvider: "other" },
    { requestModelId: "fallback" },
    { modelParams: undefined, extraParams: { priorityScheduling: true } },
  ])("does not enable a different provider/model or global params: %j", async (scenario) => {
    expect(
      await captureRequest({ modelParams: { priorityScheduling: true }, ...scenario }),
    ).not.toHaveProperty("priority");
  });
});
