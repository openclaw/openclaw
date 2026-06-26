// LM Studio embedding provider tests cover model preload context length passing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() => vi.fn());
const createRemoteEmbeddingProviderMock = vi.hoisted(() => vi.fn((_opts: unknown) => ({})));

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    ensureLmstudioModelLoaded: (params: unknown) => ensureLmstudioModelLoadedMock(params),
  };
});

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return {
    ...actual,
    resolveLmstudioInferenceBase: (_baseUrl?: string) => "http://127.0.0.1:1234/v1",
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioProviderHeaders: async () => ({}),
    resolveLmstudioRuntimeApiKey: async () => undefined,
    buildLmstudioAuthHeaders: () => ({}),
  };
});

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    createRemoteEmbeddingProvider: (opts: unknown) => createRemoteEmbeddingProviderMock(opts),
  };
});

function buildConfig(overrides?: Record<string, unknown>) {
  return {
    models: {
      providers: {
        lmstudio: {
          models: [
            {
              id: "text-embedding-qwen3-embedding-0.6b",
              contextWindow: 8192,
            },
          ],
          ...overrides,
        },
      },
    },
  } as Record<string, unknown>;
}

function requireMockCallArg(mock: { mock: { calls: unknown[][] } }, label: string) {
  const call = mock.mock.calls[0];
  if (!call) throw new Error(`expected ${label} call`);
  return call;
}

describe("createLmstudioEmbeddingProvider", () => {
  beforeEach(() => {
    ensureLmstudioModelLoadedMock.mockReset();
  });

  it("passes model-level contextWindow as requestedContextLength to preload", async () => {
    await createLmstudioEmbeddingProvider({
      config: buildConfig() as never,
      model: "text-embedding-qwen3-embedding-0.6b",
    });

    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
    const record = params as Record<string, unknown>;
    expect(record.requestedContextLength).toBe(8192);
  });

  it("prefers model contextTokens over contextWindow", async () => {
    await createLmstudioEmbeddingProvider({
      config: buildConfig({
        models: [
          {
            id: "text-embedding-qwen3-embedding-0.6b",
            contextTokens: 4096,
            contextWindow: 32768,
          },
        ],
      }) as never,
      model: "text-embedding-qwen3-embedding-0.6b",
    });

    const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
    expect((params as Record<string, unknown>).requestedContextLength).toBe(4096);
  });

  it("falls back to provider-level contextWindow when model has no context config", async () => {
    await createLmstudioEmbeddingProvider({
      config: buildConfig({
        contextWindow: 16384,
        models: [{ id: "text-embedding-qwen3-embedding-0.6b" }],
      }) as never,
      model: "text-embedding-qwen3-embedding-0.6b",
    });

    const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
    expect((params as Record<string, unknown>).requestedContextLength).toBe(16384);
  });

  it("prefers provider contextTokens over provider contextWindow", async () => {
    await createLmstudioEmbeddingProvider({
      config: buildConfig({
        contextTokens: 2048,
        contextWindow: 65536,
        models: [{ id: "text-embedding-qwen3-embedding-0.6b" }],
      }) as never,
      model: "text-embedding-qwen3-embedding-0.6b",
    });

    const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
    expect((params as Record<string, unknown>).requestedContextLength).toBe(2048);
  });

  it("omits requestedContextLength when no context config is set", async () => {
    await createLmstudioEmbeddingProvider({
      config: buildConfig({
        models: [{ id: "text-embedding-qwen3-embedding-0.6b" }],
      }) as never,
      model: "text-embedding-qwen3-embedding-0.6b",
    });

    const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
    expect((params as Record<string, unknown>).requestedContextLength).toBeUndefined();
  });
});
