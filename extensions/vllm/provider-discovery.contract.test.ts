import { clampThinkingLevel, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describeVllmProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import vllmPlugin from "./index.js";

describeVllmProviderDiscoveryContract({
  load: () => import("./index.js"),
});

describe("vLLM provider registration", () => {
  it.each([
    ["xhigh", "HIGH"],
    ["max", "MAX"],
  ] as const)("preserves mapped %s through session capability clamping", async (level, effort) => {
    const provider = await registerSingleProviderPlugin(vllmPlugin);
    const model: Model<"openai-completions"> = {
      id: "qwen3:8b",
      name: "Qwen",
      provider: "vllm",
      api: "openai-completions",
      baseUrl: "http://localhost:8000/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 1024,
      compat: {
        thinkingFormat: "qwen-chat-template",
        supportedReasoningEfforts: ["LOW", "HIGH", "MAX"],
        reasoningEffortMap: { low: "LOW", xhigh: "HIGH", max: "MAX" },
      },
    };
    const normalized = provider.normalizeResolvedModel?.({
      provider: "vllm",
      modelId: model.id,
      model,
    });
    const prepared = { ...model, thinkingLevelMap: normalized?.thinkingLevelMap };
    const selected = clampThinkingLevel(prepared, level);
    expect(selected).toBe(level);
    expect(prepared.thinkingLevelMap?.[level]).toBe(effort);
  });

  it("exposes the binary thinking profile hook", async () => {
    const provider = await registerSingleProviderPlugin(vllmPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });
});
