import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { MOONSHOT_BASE_URL } from "./provider-catalog.js";

async function captureThinkingConfig(
  modelId: string,
  hook: "wrapStreamFn" | "wrapSimpleCompletionStreamFn" = "wrapSimpleCompletionStreamFn",
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const captured = createCapturedThinkingConfigStream();
  const wrapped = provider[hook]?.({
    provider: "moonshot",
    modelId,
    thinkingLevel: "off",
    streamFn: captured.streamFn,
  } as never);
  await wrapped?.(
    { api: "openai-completions", provider: "moonshot", id: modelId } as Model<"openai-completions">,
    { messages: [] } as Context,
    {},
  );
  return { provider, captured, payload: captured.getCapturedPayload() };
}

describe("moonshot provider plugin", () => {
  it.each<{ name: string; route: Partial<Model>; expected: boolean }>([
    { name: "userinfo", route: { baseUrl: "https://u@api.moonshot.ai/v1" }, expected: false },
  ])("enables native video only for the exact $name route", async ({ route, expected }) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = {
      id: "kimi-k3",
      name: "Kimi K3",
      provider: "moonshot",
      api: "openai-completions",
      baseUrl: MOONSHOT_BASE_URL,
      reasoning: true,
      input: expected ? ["text", "image"] : ["text", "image", "video"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 1_000_000,
      ...route,
    } as unknown as Model;
    const normalized = provider.normalizeResolvedModel?.({
      provider: model.provider,
      modelId: model.id,
      model,
    } as never);

    expect(((normalized ?? model).input as string[]).includes("video")).toBe(expected);
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

  it.each(["constructor"])(
    "keeps inherited object key %s outside the always-thinking model family",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const capturedStream = createCapturedThinkingConfigStream();
      expect(provider.isModernModelRef?.({ provider: "moonshot", modelId })).toBe(false);
      expect(
        provider.resolveThinkingProfile?.({ provider: "moonshot", modelId, reasoning: true }),
      ).toEqual({
        levels: [
          { id: "off", label: "off" },
          { id: "low", label: "on" },
        ],
        defaultLevel: "off",
      });
      expect(
        provider.wrapSimpleCompletionStreamFn?.({
          provider: "moonshot",
          modelId,
          streamFn: capturedStream.streamFn,
        }),
      ).toBe(capturedStream.streamFn);
    },
  );

  it("exposes Kimi K3 as an always-max-thinking modern model", async () => {
    const { provider, payload } = await captureThinkingConfig("kimi-k3");
    expect(payload).toEqual({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning_effort: "max",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "moonshot",
        modelId: "kimi-k3",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(provider.isModernModelRef?.({ provider: "moonshot", modelId: "kimi-k3" })).toBe(true);
  });
});
