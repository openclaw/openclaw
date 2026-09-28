import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
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

function wrapModel(model: Model, streamFn?: StreamFn) {
  return wrapFireworksProviderStream({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn,
  });
}

function capturePayload(
  model: Model,
  payload: Record<string, unknown> = {},
  onPayload?: NonNullable<Parameters<StreamFn>[2]>["onPayload"],
): Record<string, unknown> {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = wrapModel(model, baseStreamFn);
  if (!wrapped) {
    throw new Error("expected Fireworks stream wrapper");
  }
  void wrapped(model, { messages: [] }, { onPayload });
  return payload;
}

describe("wrapFireworksProviderStream", () => {
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
      wrapModel(createModel({ id: "accounts/fireworks/models/qwen3.6-plus" })),
    ).toBeUndefined();
    expect(wrapModel(createModel({ api: "openai-responses" }))).toBeUndefined();
    expect(wrapModel(createModel({ provider: "fireworks-ai" }))).toBeTypeOf("function");
    expect(wrapModel(createModel({ provider: "openai" }))).toBeUndefined();
  });
});
