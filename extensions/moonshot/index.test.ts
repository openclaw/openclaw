import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  resolveAgentModelPrimaryValue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(plugin);
});

async function applyConfig(methodId: string, config: OpenClawConfig) {
  const runNonInteractive = provider.auth.find(
    (method) => method.id === methodId,
  )?.runNonInteractive;
  if (!runNonInteractive) {
    throw new Error("expected registered Moonshot noninteractive auth");
  }
  const toApiKeyCredential = vi.fn(() => null);
  const result = await runNonInteractive({
    authChoice: methodId === "api-key-cn" ? "moonshot-api-key-cn" : "moonshot-api-key",
    config,
    baseConfig: config,
    opts: {},
    runtime: createRuntimeEnv(),
    resolveApiKey: async () => ({ key: "stored-test-key", source: "profile" }),
    toApiKeyCredential,
  });
  expect(toApiKeyCredential).not.toHaveBeenCalled();
  if (!result) {
    throw new Error("expected Moonshot setup result");
  }
  return result;
}

describe("moonshot provider plugin", () => {
  it.each([
    ["international", "api-key", MOONSHOT_BASE_URL],
    ["China", "api-key-cn", MOONSHOT_CN_BASE_URL],
  ])(
    "applies the replace-mode manifest default on the %s endpoint",
    async (_name, methodId, baseUrl) => {
      const config = await applyConfig(methodId, { models: { mode: "replace" } });
      const catalog = config.models?.providers?.moonshot;
      expect(MOONSHOT_DEFAULT_MODEL_ID).toBe(manifest.modelCatalog.providers.moonshot.defaultModel);
      expect(catalog?.baseUrl).toBe(baseUrl);
      expect(catalog?.models.map((model) => model.id)).toEqual([MOONSHOT_DEFAULT_MODEL_ID]);
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        MOONSHOT_DEFAULT_MODEL_REF,
      );
      expect(config.agents?.defaults?.models).toEqual({
        [MOONSHOT_DEFAULT_MODEL_REF]: { alias: "Kimi" },
      });
    },
  );

  it("leaves ordinary catalogs runtime-owned", async () => {
    for (const mode of [undefined, "merge"] as const) {
      const config = await applyConfig("api-key", { models: { mode } });
      expect(config.models?.providers?.moonshot?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.[MOONSHOT_DEFAULT_MODEL_REF]).toEqual({
        alias: "Kimi",
      });
      expect(await applyConfig("api-key", config)).toEqual(config);
    }
  });

  it("declares shipped Moonshot provider aliases in runtime and manifest metadata", () => {
    expect(provider.aliases).toEqual(["moonshotai", "moonshot-ai"]);
    expect(manifest.providerAuthAliases).toEqual({
      moonshotai: "moonshot",
      "moonshot-ai": "moonshot",
    });
  });

  it("rewrites duplicate tool-call ids with OpenAI-style ids for Moonshot replay", () => {
    const policy = provider.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);
    expect(policy).toEqual({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      duplicateToolCallIdStyle: "openai",
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("keeps inherited object keys outside the always-thinking model family", () => {
    const ref = { provider: "moonshot", modelId: "constructor" };
    const captured = createCapturedThinkingConfigStream();
    expect(provider.isModernModelRef?.(ref)).toBe(false);
    expect(provider.resolveThinkingProfile?.({ ...ref, reasoning: true })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
    expect(provider.wrapSimpleCompletionStreamFn?.({ ...ref, streamFn: captured.streamFn })).toBe(
      captured.streamFn,
    );
  });

  it.each([
    ["kimi-k3", MOONSHOT_BASE_URL, true],
    ["kimi-k3.1-pro", MOONSHOT_BASE_URL, true],
    ["kimi-k3.1-pro-highspeed", MOONSHOT_BASE_URL, true],
    ["kimi-k3", "https://u@api.moonshot.ai/v1", false],
  ] as const)("normalizes native video for %s at %s (enabled: %s)", (id, baseUrl, enabled) => {
    const model = {
      id,
      provider: "moonshot",
      api: "openai-completions",
      baseUrl,
      input: enabled ? ["text", "image"] : ["text", "image", "video"],
    } as unknown as Model;
    const normalized = provider.normalizeResolvedModel?.({
      provider: model.provider,
      modelId: model.id,
      model,
    } as never);

    expect((normalized ?? model).input).toEqual(
      enabled ? ["text", "image", "video"] : ["text", "image"],
    );
  });

  it.each(["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])(
    "exposes %s as an always-max-thinking modern model",
    async (id) => {
      const model = { api: "openai-completions", provider: "moonshot", id } as const;
      const ref = { provider: model.provider, modelId: model.id };
      const captured = createCapturedThinkingConfigStream();
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        ...ref,
        thinkingLevel: "off",
        streamFn: captured.streamFn,
      } as never);
      await wrapped?.(model as Model<"openai-completions">, { messages: [] } as Context, {});
      expect(captured.getCapturedPayload()).toEqual({
        config: { thinkingConfig: { thinkingBudget: -1 } },
        reasoning_effort: "max",
      });
      expect(provider.resolveThinkingProfile?.({ ...ref, reasoning: true })).toEqual({
        levels: [{ id: "max", label: "max" }],
        defaultLevel: "max",
        preserveWhenCatalogReasoningFalse: true,
      });
      expect(provider.isModernModelRef?.(ref)).toBe(true);
    },
  );
});
