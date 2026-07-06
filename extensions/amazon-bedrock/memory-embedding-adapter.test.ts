// Amazon Bedrock tests cover memory embedding adapter plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hasAwsCredentialsMock = vi.hoisted(() => vi.fn());
const createBedrockEmbeddingProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return {
    ...actual,
    hasAwsCredentials: hasAwsCredentialsMock,
    createBedrockEmbeddingProvider: createBedrockEmbeddingProviderMock,
  };
});

import { bedrockMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

function stubCreate(client: { region: string; model: string; dimensions?: number }) {
  createBedrockEmbeddingProviderMock.mockResolvedValue({
    provider: {
      id: "bedrock",
      model: client.model,
      embedQuery: async () => [],
      embedBatch: async () => [],
    },
    client,
  });
}

describe("bedrockMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    hasAwsCredentialsMock.mockReset();
    createBedrockEmbeddingProviderMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./embedding-provider.js");
    vi.resetModules();
  });

  it("registers the expected adapter metadata", () => {
    expect(bedrockMemoryEmbeddingProviderAdapter.id).toBe("bedrock");
    expect(bedrockMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(bedrockMemoryEmbeddingProviderAdapter.authProviderId).toBe("amazon-bedrock");
    expect(bedrockMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(60);
    expect(bedrockMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
  });

  it("throws a missing-api-key sentinel error when AWS credentials are unavailable", async () => {
    hasAwsCredentialsMock.mockResolvedValue(false);

    await expect(
      bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow(/No API key found for provider "bedrock"/);
    await expect(
      bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow(/AWS credentials are not available/);

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: false,
    });
    expect(createBedrockEmbeddingProviderMock).not.toHaveBeenCalled();
  });

  it("creates the provider when AWS credentials are available", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0", dimensions: 1024 });

    const result = await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.id).toBe("bedrock");
    expect(result.runtime).toEqual({
      id: "bedrock",
      cacheKeyData: {
        provider: "bedrock",
        region: "us-east-1",
        model: "amazon.titan-embed-text-v2:0",
        dimensions: 1024,
      },
    });
    expect(createBedrockEmbeddingProviderMock).toHaveBeenCalledOnce();
  });

  it("allows IMDS credential probing for explicitly selected Bedrock", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      provider: "bedrock",
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("allows IMDS credential probing when Bedrock is explicitly configured in memorySearch", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: "bedrock" },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("allows IMDS credential probing for a configured Bedrock provider alias selected by id", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      provider: "my-bedrock",
      config: {
        models: {
          providers: {
            "my-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("allows IMDS credential probing when a Bedrock alias config key differs by case from the selected id", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      provider: "my-bedrock",
      config: {
        models: {
          providers: {
            "My-Bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("allows IMDS credential probing when memorySearch selects a normalized Bedrock alias id", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: " my-bedrock " },
          },
        },
        models: {
          providers: {
            "My-Bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("allows IMDS credential probing when a Bedrock provider alias is configured in memorySearch", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      config: {
        agents: {
          defaults: {
            memorySearch: { provider: "my-bedrock" },
          },
        },
        models: {
          providers: {
            "my-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: "bedrock-converse-stream",
              models: [],
            },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: true,
    });
  });

  it("does not allow IMDS probing for a non-Bedrock provider alias with the same selected id", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0" });

    await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      provider: "my-openai",
      config: {
        models: {
          providers: {
            "my-openai": {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
    });

    expect(hasAwsCredentialsMock).toHaveBeenCalledWith(process.env, undefined, {
      allowImds: false,
    });
  });

  it("lets the auto-select loop skip bedrock when credentials are unavailable", async () => {
    hasAwsCredentialsMock.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(bedrockMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection?.(thrown)).toBe(true);
  });
});
