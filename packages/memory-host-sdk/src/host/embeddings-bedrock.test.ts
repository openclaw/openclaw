import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { defaultProviderMock, resolveCredentialsMock, sendMock } = vi.hoisted(() => ({
  defaultProviderMock: vi.fn(),
  resolveCredentialsMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class MockClient {
    region: string;
    constructor(config: { region: string }) {
      this.region = config.region;
    }
    send = sendMock;
  }
  class MockCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { BedrockRuntimeClient: MockClient, InvokeModelCommand: MockCommand };
});

vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: defaultProviderMock.mockImplementation(() => resolveCredentialsMock),
}));

let createBedrockEmbeddingProvider: typeof import("./embeddings-bedrock.js").createBedrockEmbeddingProvider;
let resolveBedrockEmbeddingClient: typeof import("./embeddings-bedrock.js").resolveBedrockEmbeddingClient;
let normalizeBedrockEmbeddingModel: typeof import("./embeddings-bedrock.js").normalizeBedrockEmbeddingModel;
let hasAwsCredentials: typeof import("./embeddings-bedrock.js").hasAwsCredentials;

beforeAll(async () => {
  ({
    createBedrockEmbeddingProvider,
    resolveBedrockEmbeddingClient,
    normalizeBedrockEmbeddingModel,
    hasAwsCredentials,
  } = await import("./embeddings-bedrock.js"));
});

beforeEach(() => {
  defaultProviderMock.mockImplementation(() => resolveCredentialsMock);
});

const enc = (body: unknown) => ({ body: new TextEncoder().encode(JSON.stringify(body)) });
const reqBody = (i = 0): Record<string, unknown> =>
  JSON.parse(sendMock.mock.calls[i][0].input.body);

describe("bedrock embedding provider", () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    defaultProviderMock.mockClear();
    resolveCredentialsMock.mockReset();
    sendMock.mockReset();
  });

  // --- Normalization ---

  it("normalizes model names with prefixes", () => {
    expect(normalizeBedrockEmbeddingModel("bedrock/amazon.titan-embed-text-v2:0")).toBe(
      "amazon.titan-embed-text-v2:0",
    );
    expect(normalizeBedrockEmbeddingModel("amazon-bedrock/cohere.embed-english-v3")).toBe(
      "cohere.embed-english-v3",
    );
    expect(normalizeBedrockEmbeddingModel("")).toBe("amazon.titan-embed-text-v2:0");
  });

  // --- Client resolution ---

  it("resolves region from env", () => {
    process.env = { ...originalEnv, AWS_REGION: "eu-west-1" };
    const c = resolveBedrockEmbeddingClient({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      fallback: "none",
    });
    expect(c.region).toBe("eu-west-1");
    expect(c.dimensions).toBe(1024);
  });

  it("defaults to us-east-1", () => {
    process.env = { ...originalEnv };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    expect(
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.titan-embed-text-v2:0",
        fallback: "none",
      }).region,
    ).toBe("us-east-1");
  });

  it("extracts region from baseUrl", () => {
    process.env = { ...originalEnv };
    delete process.env.AWS_REGION;
    const c = resolveBedrockEmbeddingClient({
      config: {
        models: {
          providers: {
            "amazon-bedrock": { baseUrl: "https://bedrock-runtime.ap-southeast-2.amazonaws.com" },
          },
        },
      } as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      fallback: "none",
    });
    expect(c.region).toBe("ap-southeast-2");
  });

  it("validates dimensions", () => {
    expect(() =>
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.titan-embed-text-v2:0",
        fallback: "none",
        outputDimensionality: 768,
      }),
    ).toThrow("Invalid dimensions 768");
  });

  it("accepts valid dimensions", () => {
    expect(
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.titan-embed-text-v2:0",
        fallback: "none",
        outputDimensionality: 256,
      }).dimensions,
    ).toBe(256);
  });

  it("resolves throughput-suffixed variants", () => {
    expect(
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.titan-embed-text-v1:2:8k",
        fallback: "none",
      }).dimensions,
    ).toBe(1536);
  });

  // --- Credential detection ---

  it("detects access keys", async () => {
    await expect(
      hasAwsCredentials({
        AWS_ACCESS_KEY_ID: "A",
        AWS_SECRET_ACCESS_KEY: "s",
      } as NodeJS.ProcessEnv),
    ).resolves.toBe(true);
  });
  it("detects profile", async () => {
    await expect(hasAwsCredentials({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv)).resolves.toBe(
      true,
    );
  });
  it("detects ECS task role", async () => {
    await expect(
      hasAwsCredentials({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2" } as NodeJS.ProcessEnv),
    ).resolves.toBe(true);
  });
  it("detects EKS IRSA", async () => {
    await expect(
      hasAwsCredentials({
        AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
        AWS_ROLE_ARN: "arn:aws:iam::123:role/x",
      } as NodeJS.ProcessEnv),
    ).resolves.toBe(true);
  });
  it("detects credentials via the AWS SDK default provider chain", async () => {
    resolveCredentialsMock.mockResolvedValue({ accessKeyId: "AKIAEXAMPLE" });
    await expect(hasAwsCredentials({} as NodeJS.ProcessEnv)).resolves.toBe(true);
    expect(defaultProviderMock).toHaveBeenCalledWith({ timeout: 1000, maxRetries: 0 });
  });
  it("returns false with no creds", async () => {
    resolveCredentialsMock.mockRejectedValue(new Error("no aws credentials"));
    await expect(hasAwsCredentials({} as NodeJS.ProcessEnv)).resolves.toBe(false);
  });

  // --- Titan V2 ---

  it("embeds with Titan V2", async () => {
    sendMock.mockResolvedValue(enc({ embedding: [0.1, 0.2, 0.3] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      fallback: "none",
    });
    expect(await provider.embedQuery("test")).toHaveLength(3);
    expect(reqBody()).toMatchObject({ inputText: "test", normalize: true, dimensions: 1024 });
  });

  it("returns empty for blank text", async () => {
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      fallback: "none",
    });
    expect(await provider.embedQuery("  ")).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("batches Titan V2 concurrently", async () => {
    sendMock
      .mockResolvedValueOnce(enc({ embedding: [0.1] }))
      .mockResolvedValueOnce(enc({ embedding: [0.2] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      fallback: "none",
    });
    expect(await provider.embedBatch(["a", "b"])).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  // --- Titan V1 ---

  it("sends only inputText for Titan V1", async () => {
    sendMock.mockResolvedValue(enc({ embedding: [0.5] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-text-v1",
      fallback: "none",
    });
    await provider.embedQuery("hi");
    expect(reqBody()).toEqual({ inputText: "hi" });
  });

  it("handles Titan G1 text variant", async () => {
    sendMock.mockResolvedValue(enc({ embedding: [0.1] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.titan-embed-g1-text-02",
      fallback: "none",
    });
    await provider.embedQuery("hi");
    expect(reqBody()).toEqual({ inputText: "hi" });
  });

  // --- Cohere V3 ---

  it("embeds Cohere V3 batch in single call", async () => {
    sendMock.mockResolvedValue(enc({ embeddings: [[0.1], [0.2]] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "cohere.embed-english-v3",
      fallback: "none",
    });
    expect(await provider.embedBatch(["a", "b"])).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(reqBody()).toMatchObject({ texts: ["a", "b"], input_type: "search_document" });
  });

  it("uses search_query for Cohere embedQuery", async () => {
    sendMock.mockResolvedValue(enc({ embeddings: [[0.1]] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "cohere.embed-english-v3",
      fallback: "none",
    });
    await provider.embedQuery("q");
    expect(reqBody().input_type).toBe("search_query");
  });

  // --- Cohere V4 ---

  it("embeds Cohere V4 with embedding_types + output_dimension", async () => {
    sendMock.mockResolvedValue(enc({ embeddings: { float: [[0.1], [0.2]] } }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "cohere.embed-v4:0",
      fallback: "none",
    });
    expect(await provider.embedBatch(["a", "b"])).toHaveLength(2);
    expect(reqBody()).toMatchObject({ embedding_types: ["float"], output_dimension: 1536 });
  });

  it("validates Cohere V4 dimensions", () => {
    expect(() =>
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "cohere.embed-v4:0",
        fallback: "none",
        outputDimensionality: 2048,
      }),
    ).toThrow("Invalid dimensions 2048");
  });

  // --- Nova ---

  it("embeds Nova with SINGLE_EMBEDDING format", async () => {
    sendMock.mockResolvedValue(
      enc({ embeddings: [{ embeddingType: "TEXT", embedding: [0.1, 0.2] }] }),
    );
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.nova-2-multimodal-embeddings-v1:0",
      fallback: "none",
    });
    expect(await provider.embedQuery("hi")).toHaveLength(2);
    expect(reqBody().taskType).toBe("SINGLE_EMBEDDING");
  });

  it("validates Nova dimensions", () => {
    expect(() =>
      resolveBedrockEmbeddingClient({
        config: {} as never,
        provider: "bedrock",
        model: "amazon.nova-2-multimodal-embeddings-v1:0",
        fallback: "none",
        outputDimensionality: 512,
      }),
    ).toThrow("Invalid dimensions 512");
  });

  it("batches Nova concurrently", async () => {
    sendMock
      .mockResolvedValueOnce(enc({ embeddings: [{ embeddingType: "TEXT", embedding: [0.1] }] }))
      .mockResolvedValueOnce(enc({ embeddings: [{ embeddingType: "TEXT", embedding: [0.2] }] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "amazon.nova-2-multimodal-embeddings-v1:0",
      fallback: "none",
    });
    expect(await provider.embedBatch(["a", "b"])).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  // --- TwelveLabs ---

  it("embeds TwelveLabs Marengo", async () => {
    sendMock.mockResolvedValue(enc({ data: [{ embedding: [0.1, 0.2] }] }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "twelvelabs.marengo-embed-3-0-v1:0",
      fallback: "none",
    });
    expect(await provider.embedQuery("hi")).toHaveLength(2);
    expect(reqBody()).toEqual({ inputType: "text", text: { inputText: "hi" } });
  });

  it("embeds TwelveLabs object-style responses", async () => {
    sendMock.mockResolvedValue(enc({ data: { embedding: [0.3, 0.4] } }));
    const { provider } = await createBedrockEmbeddingProvider({
      config: {} as never,
      provider: "bedrock",
      model: "twelvelabs.marengo-embed-2-7-v1:0",
      fallback: "none",
    });
    expect(await provider.embedQuery("hi")).toEqual([0.6, 0.8]);
  });
});
