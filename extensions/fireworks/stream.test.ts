import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import { wrapFireworksProviderStream } from "./stream.js";

const glmId = "accounts/fireworks/routers/glm-5p3-fast";
const kimiId = "accounts/fireworks/routers/kimi-k2.6-synthetic-test";
const standaloneApi = "provider-stream:synthetic-fireworks";

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    api: "openai-completions",
    provider: "fireworks",
    id: kimiId,
    name: "Kimi",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 256000,
    ...overrides,
  };
}

function wrapModel(model: Model, streamFn?: StreamFn, sourceApi?: Model["api"]) {
  const { provider, id: modelId } = model;
  return wrapFireworksProviderStream({ provider, modelId, model, streamFn, sourceApi });
}

function capturePayload(model: Model, payload: Record<string, unknown>) {
  let captured: unknown;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const wrapped = wrapModel(model, baseStreamFn) ?? baseStreamFn;
  void wrapped(
    model,
    { messages: [] },
    {
      onPayload(value) {
        captured = structuredClone(value);
      },
    },
  );
  return captured;
}

it.each<[string, SimpleStreamOptions, Partial<Model>, string?]>([
  ["default router session affinity", { cacheRetention: "long" }, {}, "synthetic-session"],
  [
    "explicit cache affinity for Kimi",
    { promptCacheKey: "synthetic-cache-key" },
    { id: kimiId },
    "synthetic-cache-key",
  ],
  ["disabled cache affinity", { cacheRetention: "none" }, {}],
  ["no synthetic affinity without a session", { sessionId: undefined }, {}],
  ["explicit capability opt-out", {}, { compat: { supportsPromptCacheKey: false } }],
  ["no Fireworks affinity for a custom proxy", {}, { baseUrl: "https://proxy.example/v1" }],
])("sends %s in the provider request", async (_name, options, overrides, affinity) => {
  const provider = await registerSingleProviderPlugin(plugin);
  const originalModel = createModel({ id: glmId, ...overrides });
  const modelId = originalModel.id;
  const model =
    provider.normalizeResolvedModel?.({
      provider: originalModel.provider,
      modelId,
      model: originalModel,
    }) ?? originalModel;
  let serializedPayload = "";
  const wrapped = wrapModel(model, streamSimple) ?? streamSimple;
  const stream = await wrapped(
    model,
    {
      systemPrompt: "Stable synthetic instructions.",
      messages: [{ role: "user", content: "Synthetic question.", timestamp: 1 }],
    },
    {
      sessionId: "synthetic-session",
      ...options,
      apiKey: "synthetic-unused-key",
      onPayload(value) {
        serializedPayload = JSON.stringify(value);
        throw new Error("captured before request");
      },
    },
  );
  expect((await stream.result()).errorMessage).toBe("captured before request");
  const payload: unknown = JSON.parse(serializedPayload);
  if (affinity === undefined) {
    expect(payload).not.toHaveProperty("prompt_cache_key");
  } else {
    expect(payload).toHaveProperty("prompt_cache_key", affinity);
  }
  expect(payload).not.toHaveProperty("prompt_cache_retention");
  expect(payload).toMatchObject({
    messages: [
      { role: "system", content: "Stable synthetic instructions." },
      { role: "user", content: "Synthetic question." },
    ],
  });
  if (modelId.includes("kimi")) {
    expect(payload).toHaveProperty("thinking", { type: "disabled" });
  }
});

it.each<[string, string[], number, boolean, number, boolean?, Model["api"]?]>([
  ["header-only hit", ["100", "80"], 0, false, 80, true],
  ["header-only miss", ["100", "0"], 0, false, 0, true],
  ["standalone API alias hit", ["100", "80"], 0, false, 80, true, standaloneApi],
  ["explicit body zero", ["100", "80"], 0, true, 0],
  ["body hit", ["100", "80"], 40, true, 40],
  ["missing headers", [], 0, false, 0],
  ["invalid cache count", ["100", "101"], 0, false, 0],
  ["mismatched prompt count", ["200", "80"], 0, false, 0],
])(
  "accounts for %s without replacing billed cost",
  async (_name, headers, read, known, expected, available, api) => {
    const model = createModel({
      id: glmId,
      ...(api ? { api } : {}),
      cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 },
    });
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Synthetic reply." }],
      stopReason: "stop",
      timestamp: 1,
      usage: {
        input: 100 - read,
        output: 10,
        cacheRead: read,
        cacheWrite: 0,
        cacheTelemetry: { state: known ? "available" : "unavailable" },
        totalTokens: 110,
        cost: {
          input: ((100 - read) * 2) / 1e6,
          output: 40 / 1e6,
          cacheRead: read / 1e6,
          cacheWrite: 0,
          total: 0.5,
          totalOrigin: "provider-billed",
        },
      },
    };
    const baseStreamFn: StreamFn = async (nextModel, _context, options) => {
      await options?.onResponse?.(
        {
          status: 200,
          headers: headers.length
            ? {
                "fireworks-prompt-tokens": headers[0]!,
                "fireworks-cached-prompt-tokens": headers[1]!,
              }
            : {},
        },
        nextModel,
      );
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    const onResponse = vi.fn();
    const stream = await (wrapModel(model, baseStreamFn, "openai-completions") ?? baseStreamFn)(
      model,
      { messages: [] },
      { onResponse },
    );
    for await (const event of stream) {
      if (event.type === "done") {
        expect(event.message.usage.cacheRead).toBe(expected);
      }
    }
    expect((await stream.result()).usage).toMatchObject({
      input: 100 - expected,
      output: 10,
      cacheRead: expected,
      cacheTelemetry: { state: known || available ? "available" : "unavailable" },
      totalTokens: 110,
      cost: {
        input: ((100 - expected) * 2) / 1e6,
        cacheRead: expected / 1e6,
        total: 0.5,
        totalOrigin: "provider-billed",
      },
    });
    expect(onResponse).toHaveBeenCalledTimes(1);
  },
);

it.each<[string, Record<string, unknown>]>([
  ["accounts/fireworks/routers/kimi-k2.5-synthetic-test", {}],
  [kimiId, { reasoning_effort: "high", reasoning: { effort: "high" }, reasoningEffort: "high" }],
])("sanitizes %s before invoking the caller payload hook", (id, payload) => {
  expect(capturePayload(createModel({ id }), payload)).toEqual({
    thinking: { type: "disabled" },
  });
});

it("returns no provider wrapper for non-target Fireworks requests", () => {
  expect([
    wrapModel(
      createModel({
        id: "accounts/fireworks/models/qwen3.6-plus",
        baseUrl: "https://proxy.example/v1",
      }),
    ),
    wrapModel(createModel({ api: "openai-responses" })),
    wrapModel(createModel({ provider: "fireworks-ai" })),
    wrapModel(createModel({ provider: "openai" })),
  ]).toEqual([undefined, undefined, expect.any(Function), undefined]);
});
