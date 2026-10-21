import type { EmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/embedding-providers";
import {
  createCapturedPluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

const fetchMock = vi.fn<typeof fetch>();

async function createProvider(options: EmbeddingProviderCreateOptions) {
  const captured = createCapturedPluginRegistration();
  deepinfraPlugin.register(captured.api);
  const adapter = requireRegisteredProvider(captured.embeddingProviders, "deepinfra");
  const result = await adapter.create(options);
  if (!result.provider) {
    throw new Error("DeepInfra embedding provider missing");
  }
  return { ...result, provider: result.provider };
}

describe("DeepInfra generic embedding adapter", () => {
  beforeEach(() => {
    fetchMock
      .mockReset()
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([undefined, "https://API.DEEPINFRA.COM:443/v1/openai/"])(
    "preserves the exact existing default identity for %s",
    async (baseUrl) => {
      const result = await createProvider({
        config: {},
        model: "BAAI/bge-m3",
        remote: { apiKey: "fixture-default-key", ...(baseUrl ? { baseUrl } : {}) },
      });

      expect(result.runtime?.cacheKeyData).toEqual({
        provider: "deepinfra",
        model: "BAAI/bge-m3",
      });
    },
  );

  it("creates the configured model and preserves routing and runtime identity", async () => {
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "deepinfra",
      remote: {
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "fixture-key",
        headers: { "x-deployment": "tenant-a" },
      },
      model: "deepinfra/custom-model",
      inputType: "semantic",
      queryInputType: "query",
      documentInputType: "document",
      dimensions: 1024,
      taskType: "SEMANTIC_SIMILARITY",
    };
    const result = await createProvider(options);
    await expect(result.provider.embed({ text: "synthetic document" })).resolves.toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.deepinfra.com/v1/openai/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "custom-model", input: ["synthetic document"] }),
      }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-key");
    expect(headers.get("x-deployment")).toBe("tenant-a");
    expect(result.runtime).toEqual({
      id: "deepinfra",
      cacheKeyData: {
        provider: "deepinfra",
        model: "custom-model",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        headers: [["x-deployment", "tenant-a"]],
      },
    });
  });

  it("keeps multiple query inputs in one request and returns vectors in input order", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const { provider } = await createProvider({
      config: {},
      model: "BAAI/bge-m3",
      remote: { apiKey: "fixture-key" },
    });
    await expect(
      provider.embedBatch(["first query", "second query"], { inputType: "query" }),
    ).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.deepinfra.com/v1/openai/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "BAAI/bge-m3", input: ["first query", "second query"] }),
      }),
    );
  });

  it("partitions endpoints and tenants while excluding rotated credentials", async () => {
    const baseUrl = "https://deepinfra-region-a.example.test/v1/openai";
    const createForTenant = async (
      tenant: string,
      endpoint = baseUrl,
      apiKey = "fixture-deepinfra-key-before",
      headers: Record<string, string> = {},
    ) =>
      await createProvider({
        config: {},
        model: "BAAI/bge-m3",
        remote: {
          baseUrl: endpoint,
          apiKey,
          headers: { "x-deployment": "deployment-a", "X-Tenant": tenant, ...headers },
        },
      });

    const first = await createForTenant("tenant-a", baseUrl, "fixture-deepinfra-key-before", {
      "X-Api-Key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
      version: "tenant-api-v1",
    });
    const rotated = await createForTenant("tenant-a", baseUrl, "fixture-deepinfra-key-after", {
      version: "tenant-api-v1",
      "Api-Key": "fixture-azure-key-after",
      "x-aPI-kEY": "fixture-proxy-key-after",
    });
    const otherTenant = await createForTenant("tenant-b");
    const otherEndpoint = await createForTenant(
      "tenant-a",
      "https://deepinfra-region-b.example.test/v1/openai",
    );
    await first.provider.embed("tenant document");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/embeddings`, expect.any(Object));
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-deepinfra-key-before");
    expect(headers.get("x-api-key")).toBe("fixture-proxy-key-before");
    expect(headers.get("api-key")).toBe("fixture-azure-key-before");
    expect(headers.get("x-deployment")).toBe("deployment-a");
    expect(headers.get("x-tenant")).toBe("tenant-a");
    expect(first.runtime?.cacheKeyData).toMatchObject({
      provider: "deepinfra",
      model: "BAAI/bge-m3",
      baseUrl,
      headers: expect.arrayContaining([
        ["x-deployment", "deployment-a"],
        ["X-Tenant", "tenant-a"],
        ["version", "tenant-api-v1"],
      ]),
    });
    expect(first.runtime?.cacheKeyData).toEqual(rotated.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherTenant.runtime?.cacheKeyData);
    expect(first.runtime?.cacheKeyData).not.toEqual(otherEndpoint.runtime?.cacheKeyData);
    expect(JSON.stringify(first.runtime?.cacheKeyData)).not.toContain("fixture-");
  });
});
