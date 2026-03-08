import { describe, expect, it } from "vitest";
import {
  mergeProviderModels,
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.js";

describe("models-config merge helpers", () => {
  const preservedApiKey = "AGENT_KEY"; // pragma: allowlist secret

  it("refreshes implicit model metadata while preserving explicit reasoning overrides", () => {
    const merged = mergeProviderModels(
      {
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            input: ["text"],
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 100_000,
          },
        ],
      } as ProviderConfig,
      {
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            input: ["image"],
            reasoning: false,
            contextWindow: 2_000_000,
            maxTokens: 200_000,
          },
        ],
      } as ProviderConfig,
    );

    expect(merged.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.4",
        input: ["text"],
        reasoning: false,
        contextWindow: 2_000_000,
        maxTokens: 200_000,
      }),
    ]);
  });

  it("merges explicit providers onto trimmed keys", () => {
    const merged = mergeProviders({
      explicit: {
        " custom ": {
          api: "openai-responses",
          models: [] as ProviderConfig["models"],
        } as ProviderConfig,
      },
    });

    expect(merged).toEqual({
      custom: expect.objectContaining({ api: "openai-responses" }),
    });
  });

  it("replaces stale baseUrl when model api surface changes", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: {
          baseUrl: "https://config.example/v1",
          models: [{ id: "model", api: "openai-responses" }],
        } as ProviderConfig,
      },
      existingProviders: {
        custom: {
          baseUrl: "https://agent.example/v1",
          apiKey: preservedApiKey,
          models: [{ id: "model", api: "openai-completions" }],
        } as ExistingProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(),
    });

    expect(merged.custom).toEqual(
      expect.objectContaining({
        apiKey: preservedApiKey,
        baseUrl: "https://config.example/v1",
      }),
    );
  });
});
