import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { COHERE_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { wrapCohereProviderStream } from "./stream.js";

const COHERE_COMMAND_A_PLUS_MODEL_ID = "command-a-plus-05-2026";
const COHERE_COMMAND_A_REASONING_MODEL_ID = "command-a-reasoning-08-2025";
const COHERE_COMMAND_A_VISION_MODEL_ID = "command-a-vision-07-2025";

function buildCohereProvider() {
  return buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: manifest.modelCatalog.providers.cohere,
  });
}

function requireCohereModel(modelId = COHERE_COMMAND_A_PLUS_MODEL_ID): Model<"openai-completions"> {
  const provider = buildCohereProvider();
  const model = provider.models?.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error("Cohere catalog did not provide a model");
  }
  return {
    ...model,
    provider: "cohere",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
  } as Model<"openai-completions">;
}

function captureCoherePayload(
  context: Context,
  settings?: { modelId?: string; reasoning?: string },
): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (model, streamContext, streamOptions) => {
    const payload = buildOpenAICompletionsParams(
      model as Model<"openai-completions">,
      streamContext,
      { maxTokens: 2048, reasoning: settings?.reasoning } as never,
    );
    streamOptions?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const model = requireCohereModel(settings?.modelId);
  const wrappedStreamFn = wrapCohereProviderStream({
    provider: "cohere",
    modelId: model.id,
    model,
    streamFn: baseStreamFn,
  });
  if (!wrappedStreamFn) {
    throw new Error("Cohere wrapper did not return a stream function");
  }
  void wrappedStreamFn(model, context, {
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>;
    },
  });
  if (!captured) {
    throw new Error("Cohere payload was not captured");
  }
  return captured;
}

describe("Cohere provider plugin", () => {
  it("normalizes Cohere live catalog rows for chat discovery", () => {
    expect(COHERE_LIVE_MODEL_DISCOVERY.endpointUrl).toEqual({
      url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
      requireBaseUrl: "https://api.cohere.ai/compatibility/v1",
    });
    expect(
      COHERE_LIVE_MODEL_DISCOVERY.readRows?.({
        models: [
          {
            name: "command-fresh",
            is_deprecated: false,
            endpoints: ["chat"],
            context_length: 256_000,
          },
          { name: "command-retired", is_deprecated: true, endpoints: ["chat"] },
        ],
      }),
    ).toEqual([
      {
        id: "command-fresh",
        name: "command-fresh",
        is_deprecated: false,
        active: true,
        endpoints: ["chat"],
        context_length: 256_000,
      },
      {
        id: "command-retired",
        name: "command-retired",
        is_deprecated: true,
        active: false,
        endpoints: ["chat"],
      },
    ]);
  });

  it("uses Cohere's OpenAI-compatible completions payload fields", () => {
    const params = captureCoherePayload({
      systemPrompt: "system",
      messages: [],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as Context);

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer", content: "system" })]),
    );
    expect(params.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system", content: "system" })]),
    );
  });

  it("maps Command A+ and Command A Reasoning to Cohere's supported reasoning efforts", () => {
    const context = { messages: [] } as Context;

    for (const modelId of [COHERE_COMMAND_A_PLUS_MODEL_ID, COHERE_COMMAND_A_REASONING_MODEL_ID]) {
      expect(captureCoherePayload(context, { modelId, reasoning: "off" }).reasoning_effort).toBe(
        "none",
      );
      expect(captureCoherePayload(context, { modelId, reasoning: "medium" }).reasoning_effort).toBe(
        "high",
      );
    }
  });

  it("advertises only tool-capable current Cohere models to modern live sweeps", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isModernModelRef?.({ provider: "cohere", modelId: COHERE_COMMAND_A_PLUS_MODEL_ID }),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "cohere",
        modelId: COHERE_COMMAND_A_REASONING_MODEL_ID,
      }),
    ).toBe(true);
    expect(provider.isModernModelRef?.({ provider: "cohere", modelId: "command-a-03-2025" })).toBe(
      false,
    );
    expect(
      provider.isModernModelRef?.({
        provider: "cohere",
        modelId: COHERE_COMMAND_A_VISION_MODEL_ID,
      }),
    ).toBe(false);
  });
});
