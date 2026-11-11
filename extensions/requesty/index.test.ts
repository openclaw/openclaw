import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it, vi } from "vitest";
import { getStaticRequestyModelCatalog, projectRequestyModels } from "./api.js";
import plugin from "./index.js";

function toRequestyModel(
  definition: ReturnType<typeof getStaticRequestyModelCatalog>[number],
): Model<"openai-completions"> {
  return {
    ...definition,
    provider: "requesty",
    api: "openai-completions",
    baseUrl: "https://router.requesty.ai/v1/",
  } as Model<"openai-completions">;
}

function buildRequestyPayload(model: Model<"openai-completions">, reasoning: string) {
  return buildOpenAICompletionsParams(
    model,
    { messages: [] } as Context,
    { maxTokens: 1024, reasoning } as never,
  ) as Record<string, unknown>;
}

describe("requesty provider plugin", () => {
  it("sends thinking levels as reasoning_effort despite the router's custom base URL", () => {
    const staticModel = toRequestyModel(getStaticRequestyModelCatalog()[0]!);
    expect(buildRequestyPayload(staticModel, "high")).toHaveProperty("reasoning_effort", "high");

    const [liveReasoning, liveNonReasoning] = projectRequestyModels([
      {
        id: "kimi-k2.6",
        api: "chat",
        supports_reasoning: true,
      },
      {
        id: "gpt-4.1",
        api: "chat",
        supports_reasoning: false,
      },
    ]).map(toRequestyModel);
    expect(buildRequestyPayload(liveReasoning!, "low")).toHaveProperty("reasoning_effort", "low");
    expect(buildRequestyPayload(liveNonReasoning!, "high")).not.toHaveProperty("reasoning_effort");
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "requesty",
      modelId: "gemini-3.8-flash",
      sanitizeThoughtSignatures: true,
    });
  });

  it("adds attribution headers and keeps them provider-owned", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = toRequestyModel(getStaticRequestyModelCatalog()[0]!);
    const baseStreamFn = vi.fn<StreamFn>(() => ({}) as never);
    const wrapped = provider.wrapStreamFn?.({
      provider: "requesty",
      modelId: model.id,
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(model, { messages: [] } as Context, {
      headers: { "x-title": "spoofed", "X-Custom": "1" },
    });

    expect(baseStreamFn.mock.calls[0]?.[2]?.headers).toEqual({
      "X-Title": "OpenClaw",
      "HTTP-Referer": "https://openclaw.ai",
      "X-Custom": "1",
    });
  });

  it("leaves other providers' streams untouched", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(
      provider.wrapStreamFn?.({
        provider: "openrouter",
        modelId: "gpt-5.5",
        streamFn: (() => ({}) as never) as StreamFn,
      } as never),
    ).toBeUndefined();
  });

  it("marks Claude models as prompt-cache TTL eligible regardless of hosting prefix", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const eligible = (modelId: string) =>
      provider.isCacheTtlEligible?.({ provider: "requesty", modelId } as never);
    expect(eligible("claude-sonnet-4-6")).toBe(true);
    expect(eligible("vertex/claude-sonnet-4-6")).toBe(true);
    expect(eligible("gpt-5.5")).toBe(false);
  });

  it("publishes configured Requesty models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = {
      id: "deepinfra/moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      input: ["text"],
      reasoning: true,
      contextWindow: 262_144,
    };
    expect(
      provider.augmentModelCatalog?.({
        config: { models: { providers: { requesty: { models: [model] } } } },
      } as never),
    ).toEqual([{ provider: "requesty", ...model }]);
  });
});
