import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenAiEmbeddingClient } from "./embedding-provider.js";

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
const proxyUrl = "https://embeddings.example/v1";
const nativeUrl = "https://api.openai.com/v1";
const provider: MemoryEmbeddingProvider = {
  id: "openai",
  model,
  embed: async () => [1, 0],
  embedBatch: async (inputs) => inputs.map(() => [1, 0]),
};
async function createAdapter(client: OpenAiEmbeddingClient, id?: string) {
  mocks.createOpenAiEmbeddingProvider.mockResolvedValueOnce({ provider, client });
  return adapter.create({ config: {}, model: client.model, fallback: "none", provider: id });
}
async function cache(
  baseUrl: string,
  headers: Record<string, string>,
  providerId = "openai",
  modelId = model,
) {
  return (await createAdapter({ baseUrl, headers, model: modelId }, providerId)).runtime
    ?.cacheKeyData;
}
const tenantHeaders = (tenant: string) => ({
  "X-Deployment": tenant,
  "X-Tenant": tenant,
  version: "tenant-api-v2",
  "User-Agent": "tenant-client/2",
});
beforeEach(() => {
  mocks.createOpenAiEmbeddingProvider.mockReset();
  mocks.runOpenAiEmbeddingBatches.mockClear();
});

it("keeps native cache identity independent of OpenClaw attribution and credentials", async () => {
  // Attribution construction belongs to embeddings-remote-client.test.ts in memory-host-sdk.
  const forVersion = (version: string) =>
    cache(nativeUrl, {
      Authorization: "Bearer fixture-secret",
      "Content-Type": "application/json",
      originator: "openclaw",
      version,
      "User-Agent": `openclaw/${version}`,
    });
  const current = await forVersion("2026.7.2");
  expect(current).toEqual(await forVersion("2026.7.1"));
  expect(current).toMatchObject({
    provider: "openai",
    baseUrl: nativeUrl,
    model,
    headers: [
      ["Content-Type", "application/json"],
      ["originator", "openclaw"],
    ],
  });
  expect(JSON.stringify(current)).not.toContain("fixture-secret");
});

it.each([
  ["proxy", "bailian-embedding", proxyUrl, "X-Api-Key", "x-aPI-kEY"],
  [
    "Azure OpenAI",
    "openai",
    "https://qa-resource.openai.azure.com/openai/v1",
    "api-key",
    "Api-Key",
  ],
])(
  "excludes rotated %s credentials while preserving tenant identity",
  async (_, providerId, baseUrl, header, rotatedHeader) => {
    const forTenant = (tenant: string, key: string, name = header) =>
      cache(
        baseUrl,
        {
          Authorization: "Bearer fixture-secret",
          [name]: key,
          ...tenantHeaders(tenant),
        },
        providerId,
        "text-embedding-v3",
      );
    const first = await forTenant("tenant-a", "proxy-key-before-rotation");
    expect(first).toEqual(await forTenant("tenant-a", "proxy-key-after-rotation", rotatedHeader));
    expect(first).not.toEqual(await forTenant("tenant-b", "proxy-key-after-rotation"));
    expect(first).toMatchObject({
      provider: providerId,
      baseUrl,
      headers: expect.arrayContaining(Object.entries(tenantHeaders("tenant-a"))),
    });
    expect(JSON.stringify(first)).not.toContain("fixture-secret");
    expect(JSON.stringify(first)).not.toContain("proxy-key-before-rotation");
  },
);

it("sends document input_type in OpenAI batch embedding requests", async () => {
  const result = await createAdapter({
    baseUrl: proxyUrl,
    headers: {},
    model,
    inputType: "passage",
    documentInputType: "document",
    outputDimensionality: 512,
  });
  await result.runtime?.batchEmbed?.({
    agentId: "main",
    chunks: [{ text: "doc one" }],
    wait: true,
    concurrency: 1,
    pollIntervalMs: 1000,
    timeoutMs: 60_000,
    debug: () => {},
  });
  expect(mocks.runOpenAiEmbeddingBatches.mock.calls[0]?.[0].requests).toEqual([
    expect.objectContaining({
      body: { model, input: "doc one", dimensions: 512, input_type: "document" },
    }),
  ]);
});
