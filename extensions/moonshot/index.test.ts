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
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

async function registeredSetup(methodId: string) {
  const provider = await registerSingleProviderPlugin(plugin);
  const runNonInteractive = provider.auth.find(
    (method) => method.id === methodId,
  )?.runNonInteractive;
  if (!runNonInteractive) {
    throw new Error("expected registered Moonshot noninteractive auth");
  }
  const toApiKeyCredential = vi.fn(() => null);
  return async (config: OpenClawConfig) => {
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
  };
}

describe("moonshot provider plugin", () => {
  it.each([
    ["international", "api-key", MOONSHOT_BASE_URL],
    ["China", "api-key-cn", MOONSHOT_CN_BASE_URL],
  ])(
    "applies the replace-mode manifest default on the %s endpoint",
    async (_name, methodId, baseUrl) => {
      const applyConfig = await registeredSetup(methodId);
      const config = await applyConfig({ models: { mode: "replace" } });
      const provider = config.models?.providers?.moonshot;
      expect(MOONSHOT_DEFAULT_MODEL_ID).toBe(manifest.modelCatalog.providers.moonshot.defaultModel);
      expect(provider?.baseUrl).toBe(baseUrl);
      expect(provider?.models.map((model) => model.id)).toEqual([MOONSHOT_DEFAULT_MODEL_ID]);
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        MOONSHOT_DEFAULT_MODEL_REF,
      );
      expect(config.agents?.defaults?.models).toEqual({
        [MOONSHOT_DEFAULT_MODEL_REF]: { alias: "Kimi" },
      });
    },
  );

  it("leaves ordinary catalogs runtime-owned", async () => {
    const applyConfig = await registeredSetup("api-key");
    for (const mode of [undefined, "merge"] as const) {
      const config = await applyConfig({ models: { mode } });
      expect(config.models?.providers?.moonshot?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.[MOONSHOT_DEFAULT_MODEL_REF]).toEqual({
        alias: "Kimi",
      });
      expect(await applyConfig(config)).toEqual(config);
    }
  });

  it("disables native video for a userinfo route", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = {
      id: "kimi-k3",
      provider: "moonshot",
      api: "openai-completions",
      baseUrl: "https://u@api.moonshot.ai/v1",
      input: ["text", "image", "video"],
    } as unknown as Model;
    const normalized = provider.normalizeResolvedModel?.({
      provider: model.provider,
      modelId: model.id,
      model,
    } as never);

    expect(((normalized ?? model).input as string[]).includes("video")).toBe(false);
  });

  it("declares shipped Moonshot provider aliases in runtime and manifest metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.aliases).toEqual(["moonshotai", "moonshot-ai"]);
    expect(manifest.providerAuthAliases).toEqual({
      moonshotai: "moonshot",
      "moonshot-ai": "moonshot",
    });
  });

  it("rewrites duplicate tool-call ids with OpenAI-style ids for Moonshot replay", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
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

  it("keeps inherited object keys outside the always-thinking model family", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
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

  it("exposes Kimi K3 as an always-max-thinking modern model", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = { api: "openai-completions", provider: "moonshot", id: "kimi-k3" } as const;
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
  });
});
