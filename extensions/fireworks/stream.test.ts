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
    id: "accounts/fireworks/routers/kimi-k2.6-synthetic-test",
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
  it.each<[string, SimpleStreamOptions, Partial<Model>, string?]>([
    ["default router session affinity", { cacheRetention: "long" }, {}, "synthetic-session"],
    [
      "explicit cache affinity for Kimi",
      { promptCacheKey: "synthetic-cache-key" },
      { id: "accounts/fireworks/routers/kimi-k2.6-synthetic-test" },
      "synthetic-cache-key",
    ],
    ["disabled cache affinity", { cacheRetention: "none" }, {}],
    ["no synthetic affinity without a session", { sessionId: undefined }, {}],
    ["explicit capability opt-out", {}, { compat: { supportsPromptCacheKey: false } }],
    ["no Fireworks affinity for a custom proxy", {}, { baseUrl: "https://proxy.example/v1" }],
  ])("sends %s in the provider request", async (_name, options, overrides, affinity) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const originalModel = createModel({
      id: "accounts/fireworks/routers/glm-5p3-fast",
      ...overrides,
    });
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
    [
      "standalone API alias hit",
      ["100", "80"],
      0,
      false,
      80,
      true,
      "provider-stream:synthetic-fireworks",
    ],
    ["explicit body zero", ["100", "80"], 0, true, 0],
    ["body hit", ["100", "80"], 40, true, 40],
    ["missing headers", [], 0, false, 0],
    ["invalid cache count", ["100", "101"], 0, false, 0],
    ["mismatched prompt count", ["200", "80"], 0, false, 0],
  ])(
    "accounts for %s without replacing billed cost",
    async (_name, headers, read, known, expected, available, api) => {
      const model = createModel({
        id: "accounts/fireworks/routers/glm-5p3-fast",
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
      expect(responseCalls).toBe(1);
    },
  );

  it("forces thinking disabled for Fireworks Kimi k2.5 aliases", () => {
    expect(
      capturePayload(createModel({ id: "accounts/fireworks/routers/kimi-k2.5-synthetic-test" })),
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
