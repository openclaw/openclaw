import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../../../src/agents/model-auth.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../../../../src/infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    fetchImpl?: typeof fetch;
  }) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("fetch is not available");
    }
    const response = await fetchImpl(params.url, params.init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {},
    };
  },
}));

vi.mock("../../../../src/agents/model-auth.js", async () => {
  const { createModelAuthMockModule } =
    await import("../../../../src/test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

const createGeminiFetchMock = (embeddingValues = [1, 2, 3]) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: embeddingValues } }),
  }));

const createGeminiBatchFetchMock = (count: number, embeddingValues = [1, 2, 3]) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({
      embeddings: Array.from({ length: count }, () => ({ values: embeddingValues })),
    }),
  }));

function installFetchMock(fetchMock: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchMock);
}

function parseFetchBody(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
}

function magnitude(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

let buildGeminiEmbeddingRequest: typeof import("./embeddings-gemini.js").buildGeminiEmbeddingRequest;
let buildGeminiTextEmbeddingRequest: typeof import("./embeddings-gemini.js").buildGeminiTextEmbeddingRequest;
let createGeminiEmbeddingProvider: typeof import("./embeddings-gemini.js").createGeminiEmbeddingProvider;
let DEFAULT_GEMINI_EMBEDDING_MODEL: typeof import("./embeddings-gemini.js").DEFAULT_GEMINI_EMBEDDING_MODEL;
let GEMINI_EMBEDDING_2_MODELS: typeof import("./embeddings-gemini.js").GEMINI_EMBEDDING_2_MODELS;
let isGeminiEmbedding2Model: typeof import("./embeddings-gemini.js").isGeminiEmbedding2Model;
let normalizeGeminiModel: typeof import("./embeddings-gemini.js").normalizeGeminiModel;
let resolveGeminiOutputDimensionality: typeof import("./embeddings-gemini.js").resolveGeminiOutputDimensionality;

beforeAll(async () => {
  vi.doUnmock("undici");
  ({
    buildGeminiEmbeddingRequest,
    buildGeminiTextEmbeddingRequest,
    createGeminiEmbeddingProvider,
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_2_MODELS,
    isGeminiEmbedding2Model,
    normalizeGeminiModel,
    resolveGeminiOutputDimensionality,
  } = await import("./embeddings-gemini.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

afterEach(() => {
  vi.doUnmock("undici");
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mockResolvedProviderKey(apiKey = "test-key") {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}

type GeminiFetchMock =
  | ReturnType<typeof createGeminiFetchMock>
  | ReturnType<typeof createGeminiBatchFetchMock>;

async function createProviderWithFetch(
  fetchMock: GeminiFetchMock,
  options: Partial<Parameters<typeof createGeminiEmbeddingProvider>[0]> & { model: string },
) {
  installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
  mockPublicPinnedHostname();
  mockResolvedProviderKey();
  const { provider } = await createGeminiEmbeddingProvider({
    config: {} as never,
    provider: "gemini",
    fallback: "none",
    ...options,
  });
  return provider;
}

function expectNormalizedThreeFourVector(embedding: number[]) {
  expect(embedding[0]).toBeCloseTo(0.6, 5);
  expect(embedding[1]).toBeCloseTo(0.8, 5);
  expect(magnitude(embedding)).toBeCloseTo(1, 5);
}

describe("buildGeminiTextEmbeddingRequest", () => {
  it("builds a text embedding request with optional model and dimensions", () => {
    expect(
      buildGeminiTextEmbeddingRequest({
        text: "hello",
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: { parts: [{ text: "hello" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
  });
});

describe("buildGeminiEmbeddingRequest", () => {
  it("builds a multimodal request from structured input parts", () => {
    expect(
      buildGeminiEmbeddingRequest({
        input: {
          text: "Image file: diagram.png",
          parts: [
            { type: "text", text: "Image file: diagram.png" },
            { type: "inline-data", mimeType: "image/png", data: "abc123" },
          ],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 1536,
      }),
    ).toEqual({
      model: "models/gemini-embedding-2-preview",
      content: {
        parts: [
          { text: "Image file: diagram.png" },
          { inlineData: { mimeType: "image/png", data: "abc123" } },
        ],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 1536,
    });
  });
});

// ---------- Model detection ----------

describe("isGeminiEmbedding2Model", () => {
  it("returns true for gemini-embedding-2-preview", () => {
    expect(isGeminiEmbedding2Model("gemini-embedding-2-preview")).toBe(true);
  });

  it("returns false for gemini-embedding-001", () => {
    expect(isGeminiEmbedding2Model("gemini-embedding-001")).toBe(false);
  });

  it("returns false for text-embedding-004", () => {
    expect(isGeminiEmbedding2Model("text-embedding-004")).toBe(false);
  });
});

describe("GEMINI_EMBEDDING_2_MODELS", () => {
  it("contains gemini-embedding-2-preview", () => {
    expect(GEMINI_EMBEDDING_2_MODELS.has("gemini-embedding-2-preview")).toBe(true);
  });
});

// ---------- Dimension resolution ----------

describe("resolveGeminiOutputDimensionality", () => {
  it("returns undefined for non-v2 models", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-001")).toBeUndefined();
    expect(resolveGeminiOutputDimensionality("text-embedding-004")).toBeUndefined();
  });

  it("returns 3072 by default for v2 models", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview")).toBe(3072);
  });

  it("accepts valid dimension values", () => {
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 768)).toBe(768);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1536)).toBe(1536);
    expect(resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 3072)).toBe(3072);
  });

  it("throws for invalid dimension values", () => {
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 512)).toThrow(
      /Invalid outputDimensionality 512/,
    );
    expect(() => resolveGeminiOutputDimensionality("gemini-embedding-2-preview", 1024)).toThrow(
      /Valid values: 768, 1536, 3072/,
    );
  });
});

// ---------- Provider behavior smoke coverage ----------

describe("gemini embedding provider", () => {
  it("handles legacy and v2 request/response behavior", async () => {
    const legacyFetch = createGeminiBatchFetchMock(2);
    const legacyProvider = await createProviderWithFetch(legacyFetch, {
      model: "gemini-embedding-001",
    });

    await legacyProvider.embedQuery("test query");
    await legacyProvider.embedBatch(["text1", "text2"]);

    expect(parseFetchBody(legacyFetch, 0)).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      content: { parts: [{ text: "test query" }] },
    });
    expect(parseFetchBody(legacyFetch, 0)).not.toHaveProperty("outputDimensionality");
    expect(parseFetchBody(legacyFetch, 1)).not.toHaveProperty("outputDimensionality");

    const v2QueryFetch = createGeminiFetchMock([3, 4]);
    const v2QueryProvider = await createProviderWithFetch(v2QueryFetch, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });
    expectNormalizedThreeFourVector(await v2QueryProvider.embedQuery("test query"));

    const v2BatchFetch = createGeminiBatchFetchMock(2, [3, 4]);
    const v2BatchProvider = await createProviderWithFetch(v2BatchFetch, {
      model: "gemini-embedding-2-preview",
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });
    const batch = await v2BatchProvider.embedBatch(["text1", "text2"]);
    expect(batch).toHaveLength(2);
    for (const embedding of batch) {
      expectNormalizedThreeFourVector(embedding);
    }

    expect(parseFetchBody(v2QueryFetch)).toMatchObject({
      outputDimensionality: 768,
      taskType: "SEMANTIC_SIMILARITY",
    });
    expect(parseFetchBody(v2BatchFetch).requests).toEqual([
      expect.objectContaining({ outputDimensionality: 768 }),
      expect.objectContaining({ outputDimensionality: 768 }),
    ]);
  });
});

// ---------- Model normalization ----------

describe("gemini model normalization", () => {
  it("normalizes known model prefixes and default model", () => {
    expect(normalizeGeminiModel("models/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("gemini/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("google/gemini-embedding-2-preview")).toBe(
      "gemini-embedding-2-preview",
    );
    expect(normalizeGeminiModel("")).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });

  it("returns empty arrays without fetching for blank query and empty batch", async () => {
    mockResolvedProviderKey();

    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    await expect(provider.embedQuery("   ")).resolves.toEqual([]);
    await expect(provider.embedBatch([])).resolves.toEqual([]);
  });
});
