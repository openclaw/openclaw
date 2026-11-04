import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { getStaticOpperModelCatalog, projectOpperModels } from "./api.js";
import plugin from "./index.js";

function toOpperModel(
  definition: ReturnType<typeof getStaticOpperModelCatalog>[number],
): Model<"openai-completions"> {
  return {
    ...definition,
    provider: "opper",
    api: "openai-completions",
    baseUrl: "https://api.opper.ai/v3/compat/",
  } as Model<"openai-completions">;
}

function buildOpperPayload(model: Model<"openai-completions">, reasoning: string) {
  return buildOpenAICompletionsParams(
    model,
    { messages: [] } as Context,
    { maxTokens: 1024, reasoning } as never,
  ) as Record<string, unknown>;
}

describe("opper provider plugin", () => {
  it("sends thinking levels as reasoning_effort despite the gateway's custom base URL", () => {
    const staticModel = toOpperModel(getStaticOpperModelCatalog()[0]!);
    expect(buildOpperPayload(staticModel, "high")).toHaveProperty("reasoning_effort", "high");

    const [liveReasoning, liveNonReasoning] = projectOpperModels([
      { id: "kimi-k3", opper: { type: "llm", capabilities: ["text", "reasoning"] } },
      { id: "mistral-large-2512", opper: { type: "llm", capabilities: ["text", "tools"] } },
    ]).map(toOpperModel);
    expect(buildOpperPayload(liveReasoning!, "low")).toHaveProperty("reasoning_effort", "low");
    expect(buildOpperPayload(liveNonReasoning!, "high")).not.toHaveProperty("reasoning_effort");
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opper",
      modelId: "gemini-3.8-flash",
      sanitizeThoughtSignatures: true,
    });
  });

  it("publishes configured Opper models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = {
      id: "aws/claude-sonnet-5-5",
      name: "Claude Sonnet 5.5 (EU)",
      input: ["text"],
      reasoning: true,
      contextWindow: 1_000_000,
    };
    expect(
      provider.augmentModelCatalog?.({
        config: { models: { providers: { opper: { models: [model] } } } },
      } as never),
    ).toEqual([{ provider: "opper", ...model }]);
  });
});
