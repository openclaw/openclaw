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

import { openAiMemoryEmbeddingProviderAdapter as adapter } from "./memory-embedding-adapter.js";

const model = "text-embedding-3-small";
const options = { config: {}, model, fallback: "none" as const };

const provider: MemoryEmbeddingProvider = {
  id: "openai",
  model,
  embed: async () => [1, 0],
  embedBatch: async (inputs) => inputs.map(() => [1, 0]),
};

const createAdapter = (providerId?: string, modelId = model) =>
  adapter.create({ ...options, provider: providerId, model: modelId });
const tenantHeaders = (tenant: string) => ({
  "X-Deployment": tenant,
  "X-Tenant": tenant,
  version: "tenant-api-v2",
  "User-Agent": "tenant-client/2",
});

async function createCache(
  providerId: string,
  baseUrl: string,
  modelId = model,
  headers?: Record<string, string>,
) {
  const client = await resolveRemoteEmbeddingBearerClient({
    provider: providerId,
    defaultBaseUrl: baseUrl,
    options: {
      config: { models: {} },
      model: modelId,
      remote: { apiKey: "fixture-secret", ...(headers ? { baseUrl, headers } : {}) },
    },
  });
  mocks.createOpenAiEmbeddingProvider.mockResolvedValueOnce({
    provider,
    client: { ...client, model: modelId },
  });
  const result = await createAdapter(providerId, modelId);
  return { headers: client.headers, cache: result.runtime?.cacheKeyData };
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
        model,
        inputType: "passage",
        documentInputType: "document",
        outputDimensionality: 512,
      },
    });
  });

  it("keeps native OpenAI embedding cache identity stable across OpenClaw versions", async () => {
    const createForVersion = async (version: string) => {
      vi.stubEnv("OPENCLAW_VERSION", version);
      const result = await createCache("openai", "https://api.openai.com/v1");
      expect(result.headers).toMatchObject({
        Authorization: "Bearer fixture-secret",
        version,
        "User-Agent": `openclaw/${version}`,
      });
      return result.cache;
    };

    const previous = await createForVersion("2026.7.1");
    const current = await createForVersion("2026.7.2");

    expect(current).toEqual(previous);
    expect(current).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model,
      headers: [
        ["Content-Type", "application/json"],
        ["originator", "openclaw"],
      ],
    });
    expect(JSON.stringify(current)).not.toContain("fixture-secret");
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
        const result = await createCache(providerId, baseUrl, "text-embedding-v3", {
          [proxyHeaderName]: proxyApiKey,
          ...tenantHeaders(tenant),
        });
        expect(result.headers).toMatchObject({
          Authorization: "Bearer fixture-secret",
          [proxyHeaderName]: proxyApiKey,
          "X-Deployment": tenant,
        });
        return result.cache;
      };

      const first = await createForTenant("tenant-a", "proxy-key-before-rotation");
      const rotated = await createForTenant(
        "tenant-a",
        "proxy-key-after-rotation",
        rotatedHeaderName,
      );
      const second = await createForTenant("tenant-b", "proxy-key-after-rotation");
      const headers = first?.headers;

      expect(headers).toEqual(expect.arrayContaining(Object.entries(tenantHeaders("tenant-a"))));
      expect(first).toEqual(rotated);
      expect(first).not.toEqual(second);
      expect(JSON.stringify(first)).not.toContain("fixture-secret");
      expect(JSON.stringify(first)).not.toContain("proxy-key-before-rotation");
      expect(first).toMatchObject({ provider: providerId, baseUrl });
    },
  );

  it("sends document input_type in OpenAI batch embedding requests", async () => {
    const result = await createAdapter();
    expect(mocks.createOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );

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
    expect(requests?.[0]?.body).toEqual({
      model,
      input: "doc one",
      dimensions: 512,
      input_type: "document",
    });
  });
});
