import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaEmbeddingProvider } from "./embedding-provider.js";

describe("ollama embedding provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("falls back permanently after unsupported /api/embed responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unsupported" }), {
          status: 405,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: [3, 4] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: [8, 15] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const first = await provider.embedBatch(["doc1"]);
    const second = await provider.embedBatch(["doc2"]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:11434/api/embed",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "doc1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "doc2" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});
