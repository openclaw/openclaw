import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  applyPoolsideModelId,
  createPoolsideSamplingWrapper,
  POOLSIDE_DEFAULT_TEMPERATURE,
  sanitizePoolsideSampling,
} from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;

function poolsideModel(id: string): OpenAICompletionsModel {
  return {
    id,
    name: id,
    provider: "poolside",
    api: "openai-completions",
    baseUrl: "https://inference.poolside.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
  };
}

function capturePayload(params: {
  model: OpenAICompletionsModel;
  initialPayload: Record<string, unknown>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapped = createPoolsideSamplingWrapper({
    provider: params.model.provider,
    modelId: params.model.id,
    streamFn,
  } as ProviderWrapStreamFnContext);
  if (!wrapped) {
    throw new Error("expected Poolside sampling wrapper");
  }
  void wrapped(params.model, { messages: [] }, {});
  return captured;
}

describe("sanitizePoolsideSampling", () => {
  it("defaults temperature to 0.7 when the caller sets none", () => {
    const payload: Record<string, unknown> = { model: "laguna-s-2.1" };
    sanitizePoolsideSampling(payload);
    expect(payload.temperature).toBe(POOLSIDE_DEFAULT_TEMPERATURE);
  });

  it("preserves an explicit caller temperature", () => {
    const payload: Record<string, unknown> = { temperature: 0.2 };
    sanitizePoolsideSampling(payload);
    expect(payload.temperature).toBe(0.2);
  });

  it("preserves an explicit temperature of 0", () => {
    const payload: Record<string, unknown> = { temperature: 0 };
    sanitizePoolsideSampling(payload);
    expect(payload.temperature).toBe(0);
  });

  it("strips every unsupported sampling field", () => {
    const payload: Record<string, unknown> = {
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      n: 2,
    };
    sanitizePoolsideSampling(payload);
    expect(payload).toEqual({ temperature: 0.5 });
  });
});

describe("applyPoolsideModelId", () => {
  it("prefixes a bare Laguna model id with poolside/", () => {
    const payload: Record<string, unknown> = { model: "laguna-s-2.1" };
    applyPoolsideModelId(payload);
    expect(payload.model).toBe("poolside/laguna-s-2.1");
  });

  it("prefixes the fast variant", () => {
    const fast: Record<string, unknown> = { model: "laguna-s-2.1:fast" };
    applyPoolsideModelId(fast);
    expect(fast.model).toBe("poolside/laguna-s-2.1:fast");
  });

  it("leaves an already-prefixed model id untouched", () => {
    const payload: Record<string, unknown> = { model: "poolside/laguna-m.1" };
    applyPoolsideModelId(payload);
    expect(payload.model).toBe("poolside/laguna-m.1");
  });

  it("does nothing when there is no model field", () => {
    const payload: Record<string, unknown> = { temperature: 0.7 };
    applyPoolsideModelId(payload);
    expect(payload).toEqual({ temperature: 0.7 });
  });
});

describe("createPoolsideSamplingWrapper", () => {
  it("injects the default temperature, strips unsupported fields, and prefixes the model", () => {
    expect(
      capturePayload({
        model: poolsideModel("laguna-s-2.1"),
        initialPayload: { model: "laguna-s-2.1", top_p: 0.95, frequency_penalty: 0.1 },
      }),
    ).toEqual({ model: "poolside/laguna-s-2.1", temperature: POOLSIDE_DEFAULT_TEMPERATURE });
  });

  it("keeps a caller-provided temperature while dropping unsupported fields", () => {
    expect(
      capturePayload({
        model: poolsideModel("laguna-m.1"),
        initialPayload: { model: "laguna-m.1", temperature: 0.3, top_p: 0.95 },
      }),
    ).toEqual({ model: "poolside/laguna-m.1", temperature: 0.3 });
  });

  it("leaves non-Poolside models untouched", () => {
    const foreignModel = {
      ...poolsideModel("laguna-s-2.1"),
      provider: "openai",
    } as OpenAICompletionsModel;
    expect(
      capturePayload({
        model: foreignModel,
        initialPayload: { model: "laguna-s-2.1", top_p: 0.95 },
      }),
    ).toEqual({ model: "laguna-s-2.1", top_p: 0.95 });
  });
});
