import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { wrapFireworksProviderStream } from "./stream.js";

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    api: "openai-completions",
    provider: "fireworks",
    id: "accounts/fireworks/routers/kimi-k2p6-turbo",
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
  return wrapFireworksProviderStream({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn,
    sourceApi,
  });
}

function capturePayload(
  model: Model,
  payload: Record<string, unknown> = {},
  onPayload?: NonNullable<Parameters<StreamFn>[2]>["onPayload"],
): Record<string, unknown> {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const wrapped = wrapModel(model, baseStreamFn);
  if (!wrapped) {
    throw new Error("expected Fireworks stream wrapper");
  }
  void wrapped(model, { messages: [] }, { onPayload });
  return payload;
}

describe("wrapFireworksProviderStream", () => {
  it.each<{
    name: string;
    modelId: string;
    options: SimpleStreamOptions;
    baseUrl?: string;
    compat?: Model["compat"];
    affinity: string | undefined;
  }>([
    {
      name: "session affinity for the default router",
      modelId: "accounts/fireworks/routers/glm-5p3-fast",
      options: { sessionId: "synthetic-session", cacheRetention: "long" },
      affinity: "synthetic-session",
    },
    {
      name: "explicit cache affinity for Kimi",
      modelId: "accounts/fireworks/routers/kimi-k2p6-turbo",
      options: { sessionId: "synthetic-session", promptCacheKey: "synthetic-cache-key" },
      affinity: "synthetic-cache-key",
    },
    {
      name: "disabled cache affinity",
      modelId: "accounts/fireworks/routers/glm-5p3-fast",
      options: { sessionId: "synthetic-session", cacheRetention: "none" },
      affinity: undefined,
    },
    {
      name: "no synthetic affinity without a session",
      modelId: "accounts/fireworks/routers/glm-5p3-fast",
      options: {},
      affinity: undefined,
    },
    {
      name: "explicit capability opt-out",
      modelId: "accounts/fireworks/routers/glm-5p3-fast",
      options: { sessionId: "synthetic-session" },
      compat: { supportsPromptCacheKey: false },
      affinity: undefined,
    },
    {
      name: "no Fireworks affinity for a custom proxy",
      modelId: "accounts/fireworks/routers/glm-5p3-fast",
      baseUrl: "https://proxy.example/v1",
      options: { sessionId: "synthetic-session" },
      affinity: undefined,
    },
  ])(
    "sends $name in the provider request",
    async ({ modelId, baseUrl, compat, options, affinity }) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const originalModel = createModel({ id: modelId, compat, ...(baseUrl ? { baseUrl } : {}) });
      const model =
        provider.normalizeResolvedModel?.({
          provider: originalModel.provider,
          modelId,
          model: originalModel,
        }) ?? originalModel;
      let serializedPayload = "";
      const wrapped = wrapModel(model, streamSimple) ?? streamSimple;
      const result = await (
        await wrapped(
          model,
          {
            systemPrompt: "Stable synthetic instructions.",
            messages: [{ role: "user", content: "Synthetic question.", timestamp: 1 }],
          },
          {
            ...options,
            apiKey: "synthetic-unused-key",
            onPayload(value) {
              serializedPayload = JSON.stringify(value);
              throw new Error("captured before request");
            },
          },
        )
      ).result();
      expect(result.errorMessage).toBe("captured before request");
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
    },
  );

  it.each<{
    name: string;
    headers: string[];
    read: number;
    known: boolean;
    expected: number;
    available?: boolean;
    api?: Model["api"];
  }>([
    {
      name: "header-only hit",
      headers: ["100", "80"],
      read: 0,
      known: false,
      expected: 80,
      available: true,
    },
    {
      name: "header-only miss",
      headers: ["100", "0"],
      read: 0,
      known: false,
      expected: 0,
      available: true,
    },
    {
      name: "header-only hit through a standalone API alias",
      headers: ["100", "80"],
      read: 0,
      known: false,
      expected: 80,
      available: true,
      api: "provider-stream:synthetic-fireworks",
    },
    { name: "explicit body zero", headers: ["100", "80"], read: 0, known: true, expected: 0 },
    { name: "body hit", headers: ["100", "80"], read: 40, known: true, expected: 40 },
    { name: "missing headers", headers: [], read: 0, known: false, expected: 0 },
    { name: "invalid cache count", headers: ["100", "101"], read: 0, known: false, expected: 0 },
    { name: "mismatched prompt count", headers: ["200", "80"], read: 0, known: false, expected: 0 },
  ])("accounts for $name without replacing billed cost", async (testCase) => {
    const model = createModel({
      id: "accounts/fireworks/routers/glm-5p3-fast",
      ...(testCase.api ? { api: testCase.api } : {}),
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
        input: 100 - testCase.read,
        output: 10,
        cacheRead: testCase.read,
        cacheWrite: 0,
        cacheTelemetry: { state: testCase.known ? "available" : "unavailable" },
        totalTokens: 110,
        cost: {
          input: ((100 - testCase.read) * 2) / 1e6,
          output: 40 / 1e6,
          cacheRead: testCase.read / 1e6,
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
          headers: testCase.headers.length
            ? {
                "fireworks-prompt-tokens": testCase.headers[0]!,
                "fireworks-cached-prompt-tokens": testCase.headers[1]!,
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
    let responseCalls = 0;
    const stream = await (wrapModel(model, baseStreamFn, "openai-completions") ?? baseStreamFn)(
      model,
      { messages: [] },
      {
        onResponse: () => {
          responseCalls++;
        },
      },
    );
    for await (const event of stream) {
      if (event.type === "done") {
        expect(event.message.usage.cacheRead).toBe(testCase.expected);
      }
    }
    expect((await stream.result()).usage).toMatchObject({
      input: 100 - testCase.expected,
      output: 10,
      cacheRead: testCase.expected,
      cacheTelemetry: { state: testCase.known || testCase.available ? "available" : "unavailable" },
      totalTokens: 110,
      cost: {
        input: ((100 - testCase.expected) * 2) / 1e6,
        cacheRead: testCase.expected / 1e6,
        total: 0.5,
        totalOrigin: "provider-billed",
      },
    });
    expect(responseCalls).toBe(1);
  });

  it("forces thinking disabled for Fireworks Kimi k2.5 aliases", () => {
    expect(
      capturePayload(createModel({ id: "accounts/fireworks/routers/kimi-k2.5-turbo" })),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("passes sanitized payloads to caller onPayload hooks", () => {
    let callbackPayload: unknown;
    capturePayload(
      createModel(),
      { reasoning_effort: "high", reasoning: { effort: "high" }, reasoningEffort: "high" },
      (payload) => {
        callbackPayload = structuredClone(payload);
      },
    );

    expect(callbackPayload).toEqual({ thinking: { type: "disabled" } });
  });

  it("returns no provider wrapper for non-target Fireworks requests", () => {
    expect(
      wrapModel(
        createModel({
          id: "accounts/fireworks/models/qwen3.6-plus",
          baseUrl: "https://proxy.example/v1",
        }),
      ),
    ).toBeUndefined();
    expect(wrapModel(createModel({ api: "openai-responses" }))).toBeUndefined();
    expect(wrapModel(createModel({ provider: "fireworks-ai" }))).toBeTypeOf("function");
    expect(wrapModel(createModel({ provider: "openai" }))).toBeUndefined();
  });
});
