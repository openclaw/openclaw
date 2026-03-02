import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

async function loadDiscovery() {
  const mod = await import("./azure-foundry-discovery.js");
  mod.resetAzureFoundryDiscoveryCacheForTest();
  return mod;
}

function mockModelsResponse(models: Array<{ id: string; name?: string }>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: models }),
  });
}

describe("azure-foundry-discovery", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("discovers models from Azure Foundry endpoint", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "DeepSeek-R1", name: "DeepSeek R1" },
    ]);

    const models = await discoverAzureFoundryModels({
      endpoint: "https://models.inference.ai.azure.com",
      apiKey: "test-key",
      fetchFn: fetchMock,
    });

    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toContain("gpt-4o");
    expect(models.map((m) => m.id)).toContain("DeepSeek-R1");
  });

  it("sends api-key header", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([{ id: "gpt-4o" }]);

    await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "my-secret-key",
      fetchFn: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/models?api-version="),
      expect.objectContaining({
        headers: expect.objectContaining({ "api-key": "my-secret-key" }),
      }),
    );
  });

  it("applies provider filter", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "DeepSeek-R1", name: "DeepSeek R1" },
    ]);

    const models = await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      config: { providerFilter: ["deepseek"] },
      fetchFn: fetchMock,
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("DeepSeek-R1");
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([{ id: "test-model", name: "Test Model" }]);

    const models = await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      fetchFn: fetchMock,
    });

    expect(models[0]).toMatchObject({
      contextWindow: 64000,
      maxTokens: 8192,
    });
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([{ id: "gpt-4o" }]);

    await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      fetchFn: fetchMock,
    });
    await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      fetchFn: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([{ id: "gpt-4o" }]);
    mockModelsResponse([{ id: "gpt-4o" }]);

    await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      config: { refreshInterval: 0 },
      fetchFn: fetchMock,
    });
    await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      config: { refreshInterval: 0 },
      fetchFn: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty array on API failure", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const models = await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "bad-key",
      fetchFn: fetchMock,
    });

    expect(models).toHaveLength(0);
  });

  it("infers reasoning support from model id", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([
      { id: "o4-mini", name: "o4-mini" },
      { id: "gpt-4o", name: "GPT-4o" },
    ]);

    const models = await discoverAzureFoundryModels({
      endpoint: "https://example.com",
      apiKey: "key",
      fetchFn: fetchMock,
    });

    const o4 = models.find((m) => m.id === "o4-mini");
    const gpt = models.find((m) => m.id === "gpt-4o");
    expect(o4?.reasoning).toBe(true);
    expect(gpt?.reasoning).toBe(false);
  });

  it("sets anthropic api and baseUrl for Claude models", async () => {
    const { discoverAzureFoundryModels } = await loadDiscovery();

    mockModelsResponse([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ]);

    const models = await discoverAzureFoundryModels({
      endpoint: "https://my-resource.services.ai.azure.com",
      apiKey: "key",
      fetchFn: fetchMock,
    });

    const gpt = models.find((m) => m.id === "gpt-4o");
    expect(gpt?.api).toBeUndefined();
    expect(gpt?.baseUrl).toBeUndefined();

    const claude = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(claude?.api).toBe("anthropic-messages");
    expect(claude?.baseUrl).toBe("https://my-resource.services.ai.azure.com/anthropic");
    expect(claude?.headers).toEqual({ "api-version": "2023-06-01" });
    expect(claude?.input).toEqual(["text", "image"]);
  });
});
