import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("moonshot provider plugin", () => {
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
