import { expect, it } from "vitest";
import { buildFoundryAuthResult } from "./shared.js";

it.each([
  ["gpt-5.6-sol", "openai-responses", "api-key", 1_050_000, 128_000],
  ["gpt-5.4-pro", "openai-responses", "api-key", 1_050_000, 128_000],
  ["gpt-5.4-mini", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.4-nano", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.3-codex", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.2", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.2-codex", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.1", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.1-codex", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.1-codex-mini", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5.1-codex-max", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5-mini", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5-nano", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5-codex", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5-pro", "openai-responses", "api-key", 400_000, 128_000],
  ["gpt-5-chat", "openai-responses", "api-key", 128_000, 16_384],
  ["gpt-5.1-chat", "openai-responses", "api-key", 128_000, 16_384],
  ["gpt-5.2-chat", "openai-responses", "api-key", 128_000, 16_384],
  ["gpt-5.3-chat", "openai-responses", "api-key", 128_000, 16_384],
  ["gpt-5.99-unverified", "openai-responses", "api-key", 128_000, 16_384],
  ["gpt-4o-mini", "openai-completions", "api-key", 128_000, 16_384],
  ["claude-opus-5", "anthropic-messages", "entra-id", 1_000_000, 128_000],
  ["claude-sonnet-4.6", "anthropic-messages", "entra-id", 1_000_000, 128_000],
  ["claude-sonnet-4.5", "anthropic-messages", "entra-id", 200_000, 64_000],
  ["claude-opus-4.1", "anthropic-messages", "entra-id", 200_000, 32_000],
] as const)(
  "uses native limits for %s",
  (modelNameHint, api, authMethod, contextWindow, maxTokens) => {
    const result = buildFoundryAuthResult({
      profileId: "microsoft-foundry:default",
      endpoint: "https://example.services.ai.azure.com",
      apiKey: authMethod === "api-key" ? "test-api-key" : "__entra_id_dynamic__",
      modelId: `prod-${modelNameHint}`,
      modelNameHint,
      api,
      authMethod,
    });
    const model = result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model).toMatchObject({ name: modelNameHint, api, contextWindow, maxTokens });
  },
);
