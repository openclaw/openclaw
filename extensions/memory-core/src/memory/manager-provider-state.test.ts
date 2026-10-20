import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderLifecycle,
} from "./manager-provider-state.js";

const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

vi.mock("./embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embeddings.js")>()),
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
    providerId === "ollama" ? DEFAULT_OLLAMA_EMBEDDING_MODEL : fallbackSourceModel,
}));

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: `${id}-model`,
    embed: async () => [0.1, 0.2, 0.3],
    embedBatch: async (inputs) => inputs.map(() => [0.1, 0.2, 0.3]),
  };
}

function createSettings(fallback: "ollama" | "lmstudio"): ResolvedMemorySearchConfig {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    fallback,
  } as unknown as ResolvedMemorySearchConfig;
}

describe("memory provider requests and lifecycle", () => {
  it("resolves a fallback provider as available", () => {
    const lifecycle = resolveMemoryProviderLifecycle({
      provider: createProvider("openai"),
      requestedProvider: "local",
      fallbackFrom: "local",
      fallbackReason: "worker crashed",
    });

    expect(lifecycle).toEqual({
      mode: "fallback-active",
      providerId: "openai",
      fallbackFrom: "local",
      reason: "worker crashed",
    });
  });

  it("keeps the primary endpoint and credentials out of the runtime fallback", () => {
    const sharedRemote = {
      batch: {
        enabled: true,
        wait: false,
        concurrency: 2,
        pollIntervalMs: 250,
        timeoutMinutes: 5,
      },
    };
    const remote = {
      baseUrl: "https://primary-openai.invalid/v1",
      apiKey: "test-key",
      headers: {
        Authorization: "Bearer test-secret",
        "X-OpenAI-Secret": "test-token",
      },
      ...sharedRemote,
    };
    const local = { modelPath: "/tmp/synthetic-memory-model.gguf", contextSize: 2048 };
    const forwarded = {
      inputType: "passage",
      queryInputType: "query",
      documentInputType: "document",
      outputDimensionality: 768,
      local,
    };
    const settings = {
      ...createSettings("ollama"),
      ...forwarded,
      remote,
    } satisfies ResolvedMemorySearchConfig;

    const primaryRequest = resolveMemoryPrimaryProviderRequest({ settings });
    expect(primaryRequest.remote).toBe(remote);
    expect(primaryRequest).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      ...forwarded,
    });

    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: {} as OpenClawConfig,
      settings,
      currentProviderId: "openai",
    });

    expect(fallbackRequest).toMatchObject({
      provider: "ollama",
      model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
      fallback: "none",
      remote: sharedRemote,
      ...forwarded,
    });
    expect(fallbackRequest?.remote).toEqual(sharedRemote);
  });

  it("does not activate a fallback that is already the current provider", () => {
    expect(
      resolveMemoryFallbackProviderRequest({
        cfg: {} as OpenClawConfig,
        settings: createSettings("lmstudio"),
        currentProviderId: "lmstudio",
      }),
    ).toBeNull();
  });
});
