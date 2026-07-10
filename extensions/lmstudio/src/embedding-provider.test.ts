// LM Studio embedding provider tests cover preload context-length precedence.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: { requestedContextLength?: number }) => "text-embedding-nomic-embed-text-v1.5",
  ),
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
    ensureLmstudioModelLoaded: (params: { requestedContextLength?: number }) =>
      ensureLmstudioModelLoadedMock(params),
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

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

function buildConfig(params: {
  model?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          models: [{ id: EMBEDDING_MODEL, ...params.model }],
          ...params.provider,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function readRequestedContextLength(config: OpenClawConfig): Promise<unknown> {
  await createLmstudioEmbeddingProvider({
    config,
    provider: "lmstudio",
    model: EMBEDDING_MODEL,
    fallback: "none",
  });
  expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
  return ensureLmstudioModelLoadedMock.mock.calls[0]?.[0]?.requestedContextLength;
}

describe("createLmstudioEmbeddingProvider preload context length", () => {
  beforeEach(() => {
    ensureLmstudioModelLoadedMock.mockClear();
  });

  it.each([
    {
      name: "model contextTokens before every fallback",
      model: { contextTokens: 4096, contextWindow: 8192 },
      provider: { contextTokens: 2048, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "provider contextTokens as the model's effective cap",
      model: { contextWindow: 8192 },
      provider: { contextTokens: 4096, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "model contextWindow when below the provider cap",
      model: { contextWindow: 8192 },
      provider: { contextTokens: 16384, contextWindow: 32768 },
      expected: 8192,
    },
    {
      name: "provider contextTokens when the model has no context fields",
      provider: { contextTokens: 4096, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "model contextWindow before provider contextWindow",
      model: { contextWindow: 8192 },
      provider: { contextWindow: 16384 },
      expected: 8192,
    },
    {
      name: "provider contextWindow as the final configured fallback",
      provider: { contextWindow: 16384 },
      expected: 16384,
    },
    {
      name: "the loader default when no context is configured",
      expected: undefined,
    },
  ])("uses $name", async ({ model, provider, expected }) => {
    await expect(readRequestedContextLength(buildConfig({ model, provider }))).resolves.toBe(
      expected,
    );
  });
});
