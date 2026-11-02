import type { EmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/embedding-providers";
import {
  createCapturedPluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

const fetchMock = vi.fn<typeof fetch>();
const defaultBaseUrl = "https://api.deepinfra.com/v1/openai";
const defaultModel = "BAAI/bge-m3";
const defaultIdentity = { provider: "deepinfra", model: defaultModel };
const firstVector = [1, 0];
const vectors = [firstVector, [0, 1]];
const embeddingResponse = (values: number[][]) =>
  Response.json({
    data: values.map((embedding, index) => ({ index, embedding })).toReversed(),
  });
function expectEmbeddingRequest(model: string, input: string[]) {
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    `${defaultBaseUrl}/embeddings`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ model, input }) }),
  );
}

type Remote = NonNullable<EmbeddingProviderCreateOptions["remote"]>;
async function createProvider(remote: Remote = {}, model = defaultModel) {
  const captured = createCapturedPluginRegistration();
  deepinfraPlugin.register(captured.api);
  const result = await requireRegisteredProvider(captured.embeddingProviders, "deepinfra").create({
    config: {},
    model,
    remote: { apiKey: "fixture-key", ...remote },
  });
  if (!result.provider) {
    throw new Error("DeepInfra embedding provider missing");
  }
  return { ...result, provider: result.provider };
}

describe("DeepInfra generic embedding adapter", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(embeddingResponse([firstVector]));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    for (const name of "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy".split(
      " ",
    )) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, defaultModel, undefined, defaultIdentity],
    ["https://API.DEEPINFRA.COM:443/v1/openai/", defaultModel, undefined, defaultIdentity],
    [
      defaultBaseUrl,
      "deepinfra/custom-model",
      { "x-deployment": "tenant-a" },
      {
        provider: "deepinfra",
        model: "custom-model",
        baseUrl: defaultBaseUrl,
        headers: [["x-deployment", "tenant-a"]],
      },
    ],
  ] as const)(
    "preserves routing and runtime identity for %s (%s)",
    async (baseUrl, model, headers, cacheKeyData) => {
      const result = await createProvider({ baseUrl, headers }, model);
      expect(result.runtime).toEqual({ id: "deepinfra", cacheKeyData });
      await expect(result.provider.embed({ text: "doc" })).resolves.toEqual(firstVector);
      expectEmbeddingRequest(cacheKeyData.model, ["doc"]);
      expect(Object.fromEntries(new Headers(fetchMock.mock.calls[0]?.[1]?.headers))).toMatchObject({
        authorization: "Bearer fixture-key",
        ...headers,
      });
    },
  );

  it("keeps multiple query inputs in one request and returns vectors in input order", async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse(vectors));
    const { provider } = await createProvider();
    await expect(
      provider.embedBatch(["first query", "second query"], { inputType: "query" }),
    ).resolves.toEqual(vectors);
    expectEmbeddingRequest(defaultModel, ["first query", "second query"]);
  });

  it("partitions endpoints and tenants while excluding rotated credentials", async () => {
    const baseUrl = "https://region-a.example.test/v1/openai";
    const createForTenant = async (tenant = "tenant-a", endpoint = baseUrl, rotated = false) => {
      const phase = rotated ? "after" : "before";
      return await createProvider({
        baseUrl: endpoint,
        apiKey: `fixture-deepinfra-key-${phase}`,
        headers: {
          "x-deployment": "deployment-a",
          "X-Tenant": tenant,
          version: "tenant-api-v1",
          [rotated ? "x-aPI-kEY" : "X-Api-Key"]: `fixture-proxy-key-${phase}`,
          [rotated ? "Api-Key" : "api-key"]: `fixture-azure-key-${phase}`,
        },
      });
    };
    const first = await createForTenant();
    const rotated = await createForTenant("tenant-a", baseUrl, true);
    const otherTenant = await createForTenant("tenant-b");
    const otherEndpoint = await createForTenant("tenant-a", "https://b.test/v1/openai");
    await first.provider.embed("tenant document");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/embeddings`, expect.any(Object));
    expect(Object.fromEntries(new Headers(fetchMock.mock.calls[0]?.[1]?.headers))).toMatchObject({
      authorization: "Bearer fixture-deepinfra-key-before",
      "x-api-key": "fixture-proxy-key-before",
      "api-key": "fixture-azure-key-before",
      "x-deployment": "deployment-a",
      "x-tenant": "tenant-a",
    });
    expect(first.runtime?.cacheKeyData).toMatchObject({
      provider: "deepinfra",
      model: defaultModel,
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
