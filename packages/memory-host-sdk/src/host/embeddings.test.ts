import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../../../src/agents/model-auth.js";
import { createEmbeddingProvider, DEFAULT_LOCAL_MODEL } from "./embeddings.js";
import * as nodeLlamaModule from "./node-llama.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

vi.mock("../../../../src/agents/model-auth.js", async () => {
  const { createModelAuthMockModule } =
    await import("../../../../src/test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

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

const createEmbeddingDataFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
  }));

const createGeminiFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: [1, 2, 3] } }),
  }));

beforeEach(() => {
  vi.spyOn(authModule, "resolveApiKeyForProvider");
  vi.spyOn(nodeLlamaModule, "importNodeLlamaCpp");
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function installFetchMock(fetchMock: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchMock);
}

function readFirstFetchRequest(fetchMock: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { url, init: init as RequestInit | undefined };
}

function requireProvider(result: Awaited<ReturnType<typeof createEmbeddingProvider>>) {
  if (!result.provider) {
    throw new Error("Expected embedding provider");
  }
  return result.provider;
}

function mockResolvedProviderKey(apiKey = "provider-key") {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}

describe("package embedding provider smoke", () => {
  it("uses remote OpenAI baseUrl/apiKey and merges headers", async () => {
    const fetchMock = createEmbeddingDataFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey("provider-key");

    const result = await createEmbeddingProvider({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              headers: { "X-Provider": "p", "X-Shared": "provider" },
            },
          },
        },
      } as never,
      provider: "openai",
      remote: {
        baseUrl: "https://example.com/v1",
        apiKey: "  remote-key  ",
        headers: { "X-Shared": "remote", "X-Remote": "r" },
      },
      model: "text-embedding-3-small",
      fallback: "openai",
    });

    await requireProvider(result).embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).not.toHaveBeenCalled();
    const { url, init } = readFirstFetchRequest(fetchMock);
    expect(url).toBe("https://example.com/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-key");
    expect(headers["X-Provider"]).toBe("p");
    expect(headers["X-Shared"]).toBe("remote");
    expect(headers["X-Remote"]).toBe("r");
  });

  it("uses GEMINI_API_KEY env indirection for Gemini remote apiKey", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key");

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      remote: {
        apiKey: "GEMINI_API_KEY", // pragma: allowlist secret
      },
      model: "text-embedding-004",
      fallback: "openai",
    });

    await requireProvider(result).embedQuery("hello");

    const { init } = readFirstFetchRequest(fetchMock);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("env-gemini-key");
  });

  it("normalizes local embeddings and resolves the default local model", async () => {
    const resolveModelFileMock = vi.fn(async () => "/fake/model.gguf");
    vi.mocked(nodeLlamaModule.importNodeLlamaCpp).mockResolvedValue({
      getLlama: async () => ({
        loadModel: vi.fn().mockResolvedValue({
          createEmbeddingContext: vi.fn().mockResolvedValue({
            getEmbeddingFor: vi.fn().mockResolvedValue({
              vector: new Float32Array([2.35, 3.45, 0.63, 4.3]),
            }),
          }),
        }),
      }),
      resolveModelFile: resolveModelFileMock,
      LlamaLogLevel: { error: 0 },
    } as never);

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "local",
      model: "",
      fallback: "none",
    });

    const embedding = await requireProvider(result).embedQuery("test query");
    const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
    expect(resolveModelFileMock).toHaveBeenCalledWith(DEFAULT_LOCAL_MODEL, undefined);
  });

  it("returns null provider when explicit primary and fallback auth paths fail", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );

    const result = await createEmbeddingProvider({
      config: {} as never,
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "gemini",
    });

    expect(result.provider).toBeNull();
    expect(result.requestedProvider).toBe("openai");
    expect(result.fallbackFrom).toBe("openai");
    expect(result.providerUnavailableReason).toContain("Fallback to gemini failed");
  });
});
