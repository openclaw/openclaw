import {
  resolveRemoteEmbeddingBearerClient,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenAiEmbeddingProvider: vi.fn(),
  runOpenAiEmbeddingBatches: vi.fn(
    async (_options: { requests: { body: Record<string, unknown> }[] }) => new Map([["0", [1, 0]]]),
  ),
}));

vi.mock("./embedding-provider.js", () => ({
  createOpenAiEmbeddingProvider: mocks.createOpenAiEmbeddingProvider,
}));

vi.mock("./embedding-batch.js", () => ({
  OPENAI_BATCH_ENDPOINT: "/v1/embeddings",
  runOpenAiEmbeddingBatches: mocks.runOpenAiEmbeddingBatches,
}));

import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const provider: MemoryEmbeddingProvider = {
  id: "openai",
  model: "text-embedding-3-small",
  embed: async () => [1, 0],
  embedBatch: async (inputs) => inputs.map(() => [1, 0]),
};

const model = "text-embedding-3-small";
function createAdapter(providerId = "openai", modelId = model) {
  return openAiMemoryEmbeddingProviderAdapter.create({
    config: {},
    provider: providerId,
    model: modelId,
    fallback: "none",
  });
}

async function createWithClient(
  client: Awaited<ReturnType<typeof resolveRemoteEmbeddingBearerClient>>,
  providerId = "openai",
  modelId = model,
) {
  mocks.createOpenAiEmbeddingProvider.mockResolvedValueOnce({
    provider,
    client: { ...client, model: modelId },
  });
  return createAdapter(providerId, modelId);
}

describe("OpenAI memory embedding adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.createOpenAiEmbeddingProvider.mockReset();
    mocks.runOpenAiEmbeddingBatches.mockClear();
    mocks.createOpenAiEmbeddingProvider.mockResolvedValue({
      provider,
      client: {
        baseUrl: "https://embeddings.example/v1",
        headers: {},
        model: "text-embedding-3-small",
        inputType: "passage",
        documentInputType: "document",
        outputDimensionality: 512,
      },
    });
  });

  it("keeps native OpenAI embedding cache identity stable across OpenClaw versions", async () => {
    const createForVersion = async (version: string) => {
      vi.stubEnv("OPENCLAW_VERSION", version);
      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: {} },
          model: "text-embedding-3-small",
          remote: { apiKey: "fixture-secret" },
        },
      });
      const result = await createWithClient(client);
      expect(client.headers).toMatchObject({
        Authorization: "Bearer fixture-secret",
        version,
        "User-Agent": `openclaw/${version}`,
      });
      return { headers: client.headers, cacheKeyData: result.runtime?.cacheKeyData };
    };

    const previous = await createForVersion("2026.7.1");
    const current = await createForVersion("2026.7.2");

    expect(current.cacheKeyData).toEqual(previous.cacheKeyData);
    expect(current.cacheKeyData).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      headers: [
        ["Content-Type", "application/json"],
        ["originator", "openclaw"],
      ],
    });
    expect(JSON.stringify(current.cacheKeyData)).not.toContain("fixture-secret");
  });

  it.each([
    ["proxy", "bailian-embedding", "https://embeddings.example/v1", "X-Api-Key", "x-aPI-kEY"],
    [
      "Azure OpenAI",
      "openai",
      "https://qa-resource.openai.azure.com/openai/v1",
      "api-key",
      "Api-Key",
    ],
  ])(
    "keeps rotated %s credentials out of tenant-specific embedding cache identity",
    async (_name, providerId, baseUrl, headerName, rotatedHeaderName) => {
      const createForTenant = async (
        tenant: string,
        proxyApiKey: string,
        proxyHeaderName = headerName,
      ) => {
        const client = await resolveRemoteEmbeddingBearerClient({
          provider: providerId,
          defaultBaseUrl: baseUrl,
          options: {
            config: { models: {} },
            model: "text-embedding-v3",
            remote: {
              baseUrl,
              apiKey: "fixture-secret",
              headers: {
                [proxyHeaderName]: proxyApiKey,
                "X-Deployment": tenant,
                "X-Tenant": tenant,
                version: "tenant-api-v2",
                "User-Agent": "tenant-client/2",
              },
            },
          },
        });
        expect(client.headers).toMatchObject({
          Authorization: "Bearer fixture-secret",
          [proxyHeaderName]: proxyApiKey,
          "X-Deployment": tenant,
        });
        return createWithClient(client, providerId, "text-embedding-v3");
      };

      const first = await createForTenant("tenant-a", "proxy-key-before-rotation");
      const rotated = await createForTenant(
        "tenant-a",
        "proxy-key-after-rotation",
        rotatedHeaderName,
      );
      const second = await createForTenant("tenant-b", "proxy-key-after-rotation");
      const headers = first.runtime?.cacheKeyData?.headers;

      expect(headers).toEqual(
        expect.arrayContaining([
          ["X-Deployment", "tenant-a"],
          ["X-Tenant", "tenant-a"],
          ["version", "tenant-api-v2"],
          ["User-Agent", "tenant-client/2"],
        ]),
      );
      expect(first.runtime?.cacheKeyData).toEqual(rotated.runtime?.cacheKeyData);
      expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
      expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain("fixture-secret");
      expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain(
        "proxy-key-before-rotation",
      );
      expect(first.runtime?.cacheKeyData).toMatchObject({ provider: providerId, baseUrl });
    },
  );

  it("sends document input_type in OpenAI batch embedding requests", async () => {
    const result = await createAdapter();

    await result.runtime?.batchEmbed?.({
      agentId: "main",
      chunks: [{ text: "doc one" }],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      debug: () => {},
    });

    const requests = mocks.runOpenAiEmbeddingBatches.mock.calls[0]?.[0].requests;
    expect(requests).toHaveLength(1);
    expect(requests?.[0].body).toEqual({
      model,
      input: "doc one",
      dimensions: 512,
      input_type: "document",
    });
  });

  it("defaults provider id to openai when the caller leaves it unset", async () => {
    await openAiMemoryEmbeddingProviderAdapter.create({
      config: {},
      model: "text-embedding-3-small",
      fallback: "none",
    });

    expect(mocks.createOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
      }),
    );
  });
});
