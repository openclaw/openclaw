// Lmstudio tests cover embedding provider preload context-length wiring.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => Promise.resolve("text-embedding-nomic-embed-text-v1.5")),
);
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    ensureLmstudioModelLoaded: (params: unknown) => ensureLmstudioModelLoadedMock(params),
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioProviderHeaders: (params: unknown) => resolveLmstudioProviderHeadersMock(params),
    resolveLmstudioRuntimeApiKey: (params: unknown) => resolveLmstudioRuntimeApiKeyMock(params),
  };
});

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

function buildConfig(model: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          models: [{ id: EMBEDDING_MODEL, ...model }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function createEmbeddingProvider(config: OpenClawConfig) {
  await createLmstudioEmbeddingProvider({
    config,
    provider: "lmstudio",
    model: EMBEDDING_MODEL,
    fallback: "none",
  } as unknown as Parameters<typeof createLmstudioEmbeddingProvider>[0]);
}

describe("createLmstudioEmbeddingProvider preload context length", () => {
  it("prefers the configured contextTokens when preloading the embedding model", async () => {
    ensureLmstudioModelLoadedMock.mockClear();

    await createEmbeddingProvider(buildConfig({ contextWindow: 8192, contextTokens: 4096 }));

    expect(ensureLmstudioModelLoadedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelKey: EMBEDDING_MODEL,
        requestedContextLength: 4096,
      }),
    );
  });

  it("falls back to the configured contextWindow when contextTokens is absent", async () => {
    ensureLmstudioModelLoadedMock.mockClear();

    await createEmbeddingProvider(buildConfig({ contextWindow: 8192 }));

    expect(ensureLmstudioModelLoadedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelKey: EMBEDDING_MODEL,
        requestedContextLength: 8192,
      }),
    );
  });

  it("omits requestedContextLength when the model is not configured with a context size", async () => {
    ensureLmstudioModelLoadedMock.mockClear();

    await createEmbeddingProvider(buildConfig({}));

    expect(ensureLmstudioModelLoadedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelKey: EMBEDDING_MODEL,
        requestedContextLength: undefined,
      }),
    );
  });
});
