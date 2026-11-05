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

import { bedrockMemoryEmbeddingProviderAdapter as adapter } from "./memory-embedding-adapter.js";

const defaultCreateOptions = () => ({ config: {}, agentDir: "/tmp/test-agent", model: "" });

function createAt(endpoint: string) {
  const client = {
    region: "us-east-1",
    model: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    endpoint,
  };
  createBedrockEmbeddingProviderMock.mockResolvedValue({
    provider: {
      id: "bedrock",
      model: client.model,
      embed: async () => [],
      embedBatch: async () => [],
    },
    client,
  });
  return adapter.create(defaultCreateOptions());
}

describe("bedrockMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    hasAwsCredentialsMock.mockReset().mockResolvedValue(true);
    createBedrockEmbeddingProviderMock.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(() => {
    vi.doUnmock("./embedding-provider.js");
    vi.resetModules();
  });

  it("registers the expected adapter metadata", () => {
    expect(adapter).toMatchObject({
      id: "bedrock",
      transport: "remote",
      authProviderId: "amazon-bedrock",
      autoSelectPriority: 60,
    });
  });

  it("rejects provider creation when AWS credentials are unavailable", async () => {
    hasAwsCredentialsMock.mockResolvedValue(false);

    const creation = adapter.create(defaultCreateOptions());
    await expect(creation).rejects.toBeInstanceOf(Error);
    await expect(creation).rejects.toThrow('No API key found for provider "bedrock"');
    await expect(creation).rejects.toThrow("AWS credentials are not available");
    expect(createBedrockEmbeddingProviderMock).not.toHaveBeenCalled();
  });

  it("invalidates cached embeddings when the configured PrivateLink endpoint changes", async () => {
    const firstEndpoint = "https://vpce-first.bedrock-runtime.us-east-1.vpce.amazonaws.com";
    const secondEndpoint = "https://vpce-second.bedrock-runtime.us-east-1.vpce.amazonaws.com";

    const first = await createAt(firstEndpoint);
    const second = await createAt(secondEndpoint);

    expect(first.runtime?.cacheKeyData).toMatchObject({ endpoint: firstEndpoint });
    expect(second.runtime?.cacheKeyData).toMatchObject({ endpoint: secondEndpoint });
    expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
  });

  it("preserves existing cache identity for canonical AWS regional provider URLs", async () => {
    const actual =
      await vi.importActual<typeof import("./embedding-provider.js")>("./embedding-provider.js");
    createBedrockEmbeddingProviderMock.mockImplementation(actual.createBedrockEmbeddingProvider);
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_DEFAULT_REGION", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);

    const provider = { baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", models: [] };
    const result = await adapter.create({
      ...defaultCreateOptions(),
      config: { models: { providers: { "amazon-bedrock": provider } } },
    });

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
  });
});
