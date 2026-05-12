import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRemoteEmbeddingVectors: vi.fn(async () => [[1, 0]]),
  resolveRemoteEmbeddingClient: vi.fn(async () => ({
    baseUrl: "https://embeddings.example/v1",
    headers: { Authorization: "Bearer test" },
    model: "text-embedding-3-small",
  })),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  fetchRemoteEmbeddingVectors: mocks.fetchRemoteEmbeddingVectors,
  resolveRemoteEmbeddingClient: mocks.resolveRemoteEmbeddingClient,
}));

import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";

function createOptions(
  overrides: Partial<MemoryEmbeddingProviderCreateOptions> = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: {} as MemoryEmbeddingProviderCreateOptions["config"],
    provider: "openai",
    model: "text-embedding-3-small",
    fallback: "none",
    ...overrides,
  };
}

function expectFetchRemoteEmbeddingVectorsBody(body: Record<string, unknown>) {
  expect(mocks.fetchRemoteEmbeddingVectors).toHaveBeenCalledWith({
    url: "https://embeddings.example/v1/embeddings",
    headers: { Authorization: "Bearer test" },
    ssrfPolicy: undefined,
    fetchImpl: undefined,
    body,
    errorPrefix: "openai embeddings failed",
  });
}

describe("OpenAI embedding provider", () => {
  beforeEach(() => {
    mocks.fetchRemoteEmbeddingVectors.mockClear();
    mocks.resolveRemoteEmbeddingClient.mockClear();
  });

  it("sends queryInputType on query embeddings", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ inputType: "passage", queryInputType: "query" }),
    );

    await provider.embedQuery("hello");

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["hello"],
      input_type: "query",
    });
  });

  it("sends documentInputType on document batch embeddings", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ inputType: "query", documentInputType: "document" }),
    );

    await provider.embedBatch(["doc one", "doc two"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc one", "doc two"],
      input_type: "document",
    });
  });

  it("omits input_type unless configured", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(createOptions());

    await provider.embedBatch(["doc"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc"],
    });
  });

  it("sends outputDimensionality as OpenAI dimensions", async () => {
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ outputDimensionality: 512 }),
    );

    await provider.embedBatch(["doc"]);

    expectFetchRemoteEmbeddingVectorsBody({
      model: "text-embedding-3-small",
      input: ["doc"],
      dimensions: 512,
    });
  });

  it("forwards a custom provider id through resolveRemoteEmbeddingClient (#47884)", async () => {
    await createOpenAiEmbeddingProvider(
      createOptions({ provider: "bailian-embedding", model: "text-embedding-v3" }),
    );

    const calls = mocks.resolveRemoteEmbeddingClient.mock.calls as unknown as Array<
      [{ provider?: string }]
    >;
    const [args] = calls.at(-1) ?? [];
    expect(args?.provider).toBe("bailian-embedding");
  });

  it("falls back to 'openai' when no provider id is supplied (#47884)", async () => {
    await createOpenAiEmbeddingProvider({
      config: {} as MemoryEmbeddingProviderCreateOptions["config"],
      model: "text-embedding-3-small",
      fallback: "none",
    });

    const calls = mocks.resolveRemoteEmbeddingClient.mock.calls as unknown as Array<
      [{ provider?: string }]
    >;
    const [args] = calls.at(-1) ?? [];
    expect(args?.provider).toBe("openai");
  });
});
