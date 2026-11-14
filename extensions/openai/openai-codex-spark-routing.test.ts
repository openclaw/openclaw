import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("buildOpenAIProvider", () => {
  it("restores gpt-5.3-codex-spark only through ChatGPT/Codex OAuth routing", () => {
    const provider = buildOpenAIProvider();

    const oauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
    } as never);
    const apiKeyModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const runtimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
    } as never);
    const apiKeyRuntimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
      authProfileId: "openai:api-key",
      authProfileMode: "api_key",
      providerConfig: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const unknownModelHint = provider.buildUnknownModelHint?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    } as never);

    expectFields(oauthModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expectFields(runtimeModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expect(apiKeyModel).toBeUndefined();
    expect(apiKeyRuntimeModel).toBeUndefined();
    expect(unknownModelHint).toContain("ChatGPT/Codex OAuth");
    expect(unknownModelHint).toContain("OpenAI API-key auth cannot use this model");
  });
});
