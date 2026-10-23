import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  capturePluginRegistration,
  registerSingleProviderPlugin,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { afterEach, assert, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PLUS = "command-a-plus-05-2026";
const REASONING = "command-a-reasoning-08-2025";
const VISION = "command-a-vision-07-2025";

function requireCohereModel(modelId = PLUS): Model<"openai-completions"> {
  const provider = buildManifestModelProviderConfig({
    providerId: "cohere",
    catalog: manifest.modelCatalog.providers.cohere,
  });
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

function capturePayload(
  context: Context,
  settings?: { modelId?: string; reasoning?: string },
): Record<string, unknown> {
  const onPayload = vi.fn<(payload: unknown) => void>();
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
  const [provider] = capturePluginRegistration(plugin).providers;
  const wrappedStreamFn = provider?.wrapStreamFn?.({
    provider: "cohere",
    modelId: model.id,
    model,
    streamFn: baseStreamFn,
  });
  void wrappedStreamFn?.(model, context, { onPayload });
  expect(onPayload).toHaveBeenCalledOnce();
  const call = onPayload.mock.calls[0];
  assert(call, "Expected captured Cohere payload");
  return call[0] as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

it("keeps North Mini Code text-only with Cohere's binary reasoning contract", () => {
  const model = requireCohereModel("north-mini-code-1-0");
  expect(model.input).toEqual(["text"]);
  expect(model.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);
  expect(model.compat?.reasoningEffortMap).toEqual({
    off: "none",
    none: "none",
    ...Object.fromEntries(
      "minimal low medium high xhigh adaptive max".split(" ").map((key) => [key, "high"]),
    ),
  });
});

it("discovers active chat models through the registered Cohere catalog", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      models: [
        { name: "command-fresh", context_length: 256_000 },
        { name: "command-retired", is_deprecated: true },
      ].map((row) => Object.assign(row, { endpoints: ["chat"] })),
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await runProviderCatalog({
    provider,
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "synthetic-cohere-key" }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
    expect.anything(),
  );
  expect(result && "provider" in result && result.provider.models).toEqual([
    expect.objectContaining({ id: "command-fresh", contextWindow: 256_000 }),
  ]);
});

it("uses Cohere's OpenAI-compatible completions payload fields", () => {
  const params = capturePayload({
    systemPrompt: "system",
    messages: [],
    tools: [{ name: "lookup", description: "", parameters: { type: "object", properties: {} } }],
  } as Context);

  expect(params).toMatchObject({
    max_tokens: 2048,
    messages: [{ role: "developer", content: "system" }],
  });
  for (const field of ["max_completion_tokens", "store", "stream_options", "tool_choice"]) {
    expect(params).not.toHaveProperty(field);
  }
});

it("maps Command A+ and Command A Reasoning to Cohere's supported reasoning efforts", () => {
  for (const modelId of [PLUS, REASONING]) {
    expect(
      ["off", "medium"].map(
        (reasoning) => capturePayload({ messages: [] }, { modelId, reasoning }).reasoning_effort,
      ),
    ).toEqual(["none", "high"]);
  }
});

it("advertises only tool-capable current Cohere models to modern live sweeps", async () => {
  const provider = await registerSingleProviderPlugin(plugin);

  expect(
    [PLUS, REASONING, "command-a-03-2025", VISION].map((modelId) =>
      provider.isModernModelRef?.({ provider: "cohere", modelId }),
    ),
  ).toEqual([true, true, false, false]);
});
