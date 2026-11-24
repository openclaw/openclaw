import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "openclaw/plugin-sdk/llm";
import {
  capturePluginRegistration,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

const glmId = "accounts/fireworks/routers/glm-5p3-fast";
const kimiId = "accounts/fireworks/routers/kimi-k2.6-synthetic-test";
const proxy = "https://proxy.example/v1";

function usage(read: number, state: "available" | "unavailable"): Usage {
  return {
    input: 100 - read,
    output: 10,
    cacheRead: read,
    cacheWrite: 0,
    cacheTelemetry: { state },
    totalTokens: 110,
    cost: {
      input: ((100 - read) * 2) / 1e6,
      output: 40 / 1e6,
      cacheRead: read / 1e6,
      cacheWrite: 0,
      total: 0.5,
      totalOrigin: "provider-billed",
    },
  };
}

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
  return requireRegisteredProvider(
    capturePluginRegistration(plugin).providers,
    "fireworks",
  ).wrapStreamFn?.({ provider: model.provider, modelId: model.id, model, streamFn, sourceApi });
}

it.each<[string, SimpleStreamOptions, Partial<Model>, string?]>([
  ["default router session affinity", { cacheRetention: "long" }, {}, "synthetic-session"],
  ["explicit Kimi key", { promptCacheKey: "cache-key" }, { id: kimiId }, "cache-key"],
  ["disabled cache affinity", { cacheRetention: "none" }, {}],
  ["no synthetic affinity without a session", { sessionId: undefined }, {}],
  ["explicit capability opt-out", {}, { compat: { supportsPromptCacheKey: false } }],
  ["no Fireworks affinity for a custom proxy", {}, { baseUrl: proxy }],
])("sends %s in the provider request", async (_name, options, overrides, affinity) => {
  const provider = await registerSingleProviderPlugin(plugin);
  const originalModel = createModel({ id: glmId, ...overrides });
  const model =
    provider.normalizeResolvedModel?.({
      provider: originalModel.provider,
      modelId: originalModel.id,
      model: originalModel,
    }) ?? originalModel;
  let serializedPayload = "";
  const stream = await (wrapModel(model, streamSimple) ?? streamSimple)(
    model,
    { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
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
});

it.each<[string, string[], number, boolean, number, boolean?, Model["api"]?]>([
  ["header-only hit", ["100", "80"], 0, false, 80, true],
  ["header-only miss", ["100", "0"], 0, false, 0, true],
  ["API alias hit", ["100", "80"], 0, false, 80, true, "provider-stream:synthetic-fireworks"],
  ["explicit body zero", ["100", "80"], 0, true, 0],
  ["body hit", ["100", "80"], 40, true, 40],
  ["missing headers", [], 0, false, 0],
  ["invalid cache count", ["100", "101"], 0, false, 0],
  ["mismatched prompt count", ["200", "80"], 0, false, 0],
])("accounts for %s", async (_name, headers, read, known, expected, available, api) => {
  const model = createModel({
    id: glmId,
    ...(api ? { api } : {}),
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 },
  });
  const message = makeAgentAssistantMessage({
    content: [{ type: "text", text: "Synthetic reply." }],
    usage: usage(read, known ? "available" : "unavailable"),
  });
  const baseStreamFn: StreamFn = async (nextModel, _context, options) => {
    await options?.onResponse?.(
      {
        status: 200,
        headers: Object.fromEntries(
          headers.map((value, i) => [`fireworks-${i ? "cached-" : ""}prompt-tokens`, value]),
        ),
      },
      nextModel,
    );
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
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
  expect((await stream.result()).usage).toMatchObject(
    usage(expected, known || available ? "available" : "unavailable"),
  );
  expect(onResponse).toHaveBeenCalledTimes(1);
});

it.each<[string, Record<string, unknown>]>([
  ["accounts/fireworks/routers/kimi-k2.5-synthetic-test", {}],
  [kimiId, { reasoning_effort: "high", reasoning: { effort: "high" }, reasoningEffort: "high" }],
])("sanitizes %s before invoking the caller payload hook", async (id, payload) => {
  const model = createModel({ id });
  const onPayload = vi.fn((value) => expect(value).toEqual({ thinking: { type: "disabled" } }));
  const base: StreamFn = (nextModel, _context, options) => {
    options?.onPayload?.(payload, nextModel);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  await (wrapModel(model, base) ?? base)(model, { messages: [] }, { onPayload });
  expect(onPayload).toHaveBeenCalledOnce();
});

it("returns no provider wrapper for non-target Fireworks requests", () => {
  expect([
    wrapModel(createModel({ id: "not-kimi", baseUrl: proxy })),
    wrapModel(createModel({ api: "openai-responses" })),
    wrapModel(createModel({ provider: "fireworks-ai" })),
    wrapModel(createModel({ provider: "openai" })),
  ]).toEqual([undefined, undefined, expect.any(Function), undefined]);
});
