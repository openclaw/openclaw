// Openrouter tests cover the provider replay policy for runtime-context carriers.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

// #158898: GPT-5.6+ caches at message-end breakpoints, so a runtime-context
// carrier that moves to the end of every request makes each cached prefix
// unreachable. OpenRouter keeps the carrier in place for those models only.
describe("OpenRouter OpenAI message-end prompt caching (#158898)", () => {
  it.each([
    ["GPT-6", "openai/gpt-6-sol"],
    ["GPT-6 Pro", "openai/gpt-6-sol-pro"],
    ["GPT-5.6", "openai/gpt-5.6-luna"],
    ["nested openrouter/openai", "openrouter/openai/gpt-6-astra"],
    ["~ ref", "~openai/gpt-6"],
    ["nested ~ ref", "openrouter/~openai/gpt-6"],
    [":nitro variant", "openai/gpt-6:nitro"],
    [":floor variant", "openai/gpt-5.6-luna:floor"],
    [":online variant", "openai/gpt-6-sol:online"],
  ])("keeps the runtime-context carrier in place for %s", async (_label, modelId) => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "openrouter",
      modelApi: "openai-completions",
      modelId,
    } as never);

    expect(policy?.appendOnlyRuntimeContext).toBe(true);
    expect(policy?.toolCallIdMode).toBeUndefined();
  });

  it.each([
    ["GPT-5.5", "openai/gpt-5.5"],
    ["GPT-5.4", "openai/gpt-5.4"],
    ["GPT-5", "openai/gpt-5"],
    ["~ ref GPT-5.5", "~openai/gpt-5.5"],
    [":nitro GPT-5.5", "openai/gpt-5.5:nitro"],
    ["non-OpenAI gpt-named route", "someone/gpt-6"],
    ["Anthropic", "anthropic/claude-sonnet-4-6"],
    ["DeepSeek", "deepseek/deepseek-v4-flash"],
    ["Mistral", "mistralai/mistral-large-latest"],
  ])("keeps transient carriers for %s", async (_label, modelId) => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "openrouter",
      modelApi: "openai-completions",
      modelId,
    } as never);

    expect(policy?.appendOnlyRuntimeContext).toBeUndefined();
  });
});
