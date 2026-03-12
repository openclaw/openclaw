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
  const kimiModel: ProviderConfig["models"][number] = {
    id: "k2p5",
    name: "Kimi for Coding",
    input: ["text", "image"],
    reasoning: true,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_000,
  };

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

  it("preserves implicit provider headers when explicit config adds extra headers", () => {
    const merged = mergeProviderModels(
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        headers: { "User-Agent": "claude-code/0.1.0" },
        models: [kimiModel],
      } as ProviderConfig,
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        headers: { "X-Kimi-Tenant": "tenant-a" },
        models: [kimiModel],
      } as ProviderConfig,
    );

    expect(merged.headers).toEqual({
      "User-Agent": "claude-code/0.1.0",
      "X-Kimi-Tenant": "tenant-a",
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

  it("does not preserve stale plaintext apiKey when next entry is a marker", () => {
    const merged = mergeWithExistingProviderSecrets({
      nextProviders: {
        custom: {
          apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
          models: [{ id: "model", api: "openai-responses" }],
        } as ProviderConfig,
      },
      existingProviders: {
        custom: {
          apiKey: preservedApiKey,
          models: [{ id: "model", api: "openai-responses" }],
        } as ExistingProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
      explicitBaseUrlProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
  });
});
