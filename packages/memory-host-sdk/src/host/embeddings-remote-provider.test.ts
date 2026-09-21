import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRemoteEmbeddingVectorsDetailed: vi.fn(),
}));

vi.mock("./embeddings-remote-fetch.js", () => ({
  fetchRemoteEmbeddingVectorsDetailed: mocks.fetchRemoteEmbeddingVectorsDetailed,
}));

import { createRemoteEmbeddingProvider } from "./embeddings-remote-provider.js";

function createProvider(batchQueryInputs?: boolean) {
  return createRemoteEmbeddingProvider({
    id: "fixture",
    client: {
      baseUrl: "https://embeddings.example.test/v1",
      headers: { Authorization: "Bearer fixture" },
      model: "fixture-model",
    },
    errorPrefix: "fixture embeddings failed",
    batchQueryInputs,
  });
}

beforeEach(() => {
  mocks.fetchRemoteEmbeddingVectorsDetailed.mockReset();
  mocks.fetchRemoteEmbeddingVectorsDetailed.mockImplementation(
    async ({ body }: { body: unknown }) => {
      const input = (body as { input: string[] }).input;
      return { vectors: input.map((_, index) => [index]) };
    },
  );
});

describe("remote embedding provider request grouping", () => {
  it("runs query batches as one request per input by default", async () => {
    await createProvider().embedBatch(["first", "second"], { inputType: "query" });

    expect(
      mocks.fetchRemoteEmbeddingVectorsDetailed.mock.calls.map(([request]) => request.body.input),
    ).toEqual([["first"], ["second"]]);
  });

  it("keeps document singleton calls on the batch-shaped request path", async () => {
    await createProvider().embed({ text: "document" }, { inputType: "document" });

    expect(mocks.fetchRemoteEmbeddingVectorsDetailed).toHaveBeenCalledOnce();
    expect(mocks.fetchRemoteEmbeddingVectorsDetailed.mock.calls[0]?.[0].body.input).toEqual([
      "document",
    ]);
  });

  it("batches query inputs when the provider declares identical query and document payloads", async () => {
    await createProvider(true).embedBatch(["first", "second"], { inputType: "query" });

    expect(mocks.fetchRemoteEmbeddingVectorsDetailed).toHaveBeenCalledOnce();
    expect(mocks.fetchRemoteEmbeddingVectorsDetailed.mock.calls[0]?.[0].body.input).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("remote embedding provider usage reporting", () => {
  it("passes through provider-reported usage on the detailed batch path", async () => {
    mocks.fetchRemoteEmbeddingVectorsDetailed.mockResolvedValueOnce({
      vectors: [[0.1], [0.2]],
      usage: { promptTokens: 10, totalTokens: 12 },
    });

    await expect(
      createProvider().embedBatchDetailed?.(["first", "second"], { inputType: "document" }),
    ).resolves.toEqual({
      embeddings: [[0.1], [0.2]],
      usage: { promptTokens: 10, totalTokens: 12 },
    });
  });

  it("sums usage across per-input query requests", async () => {
    mocks.fetchRemoteEmbeddingVectorsDetailed.mockImplementation(
      async ({ body }: { body: unknown }) => {
        const input = (body as { input: string[] }).input;
        return {
          vectors: input.map((_, index) => [index]),
          usage: { promptTokens: 3, totalTokens: 4 },
        };
      },
    );

    await expect(
      createProvider().embedBatchDetailed?.(["first", "second"], { inputType: "query" }),
    ).resolves.toEqual({
      embeddings: [[0], [0]],
      usage: { promptTokens: 6, totalTokens: 8 },
    });
  });

  it("omits usage when the provider response has none", async () => {
    await expect(
      createProvider().embedBatchDetailed?.(["first"], { inputType: "document" }),
    ).resolves.toEqual({ embeddings: [[0]] });
  });

  it("keeps embedBatch returning plain vectors", async () => {
    mocks.fetchRemoteEmbeddingVectorsDetailed.mockResolvedValueOnce({
      vectors: [[0.1]],
      usage: { promptTokens: 1, totalTokens: 1 },
    });

    await expect(createProvider().embedBatch(["first"])).resolves.toEqual([[0.1]]);
  });
});
