import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("atomicchat provider plugin", () => {
  it("registers an OpenAI-compatible provider with the expected metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.id).toBe("atomicchat");
    expect(provider.label).toBe("Atomic Chat");
    expect(provider.docsPath).toBe("/providers/atomicchat");
    expect(provider.envVars).toContain("ATOMIC_CHAT_API_KEY");
  });

  it("owns OpenAI-compatible replay without dropping reasoning history", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "atomicchat",
      modelApi: "openai-completions",
      modelId: "Qwen/Qwen3-8B",
    } as never);

    expect(policy).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("still drops historical reasoning for Gemma 4 chat-completions models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "atomicchat",
      modelApi: "openai-completions",
      modelId: "google/gemma-4-26b-a4b-it",
    } as never);

    expect(policy).toHaveProperty("dropReasoningFromHistory", true);
  });
});
