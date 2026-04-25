import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../../../../src/plugins/memory-embedding-providers.js";
import { createEmbeddingProvider } from "./embeddings.js";

const missingBedrockCredentialsError = new Error(
  'No API key found for provider "bedrock". AWS credentials are not available.',
);

function createOptions(provider: string) {
  return {
    config: {
      plugins: {
        deny: [
          "amazon-bedrock",
          "github-copilot",
          "google",
          "lmstudio",
          "memory-core",
          "mistral",
          "ollama",
          "openai",
          "voyage",
        ],
      },
    } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback: "none",
    model: "",
  };
}

function createMissingCredentialsAdapter(
  overrides: Partial<MemoryEmbeddingProviderAdapter> = {},
): MemoryEmbeddingProviderAdapter {
  return {
    id: "bedrock",
    transport: "remote",
    autoSelectPriority: 60,
    formatSetupError: (err) => (err instanceof Error ? err.message : String(err)),
    shouldContinueAutoSelection: (err) =>
      err instanceof Error && err.message.includes("No API key found for provider"),
    create: async () => {
      throw missingBedrockCredentialsError;
    },
    ...overrides,
  };
}

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    clearMemoryEmbeddingProviders();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
  });

  it("returns no provider in auto mode when all candidates are skippable setup failures", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result).toEqual({
      provider: null,
      requestedProvider: "auto",
      providerUnavailableReason: missingBedrockCredentialsError.message,
    });
  });

  it("still throws missing credentials for an explicit provider request", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    await expect(createEmbeddingProvider(createOptions("bedrock"))).rejects.toThrow(
      missingBedrockCredentialsError.message,
    );
  });

  it("continues auto-selection after a skippable setup failure", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter({ autoSelectPriority: 10 }));
    registerMemoryEmbeddingProvider({
      id: "openai",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("auto");
  });
});
