import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("openclaw/plugin-sdk/github-copilot-token", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  coerceSecretRef: vi.fn(),
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  listProfilesForProvider: vi.fn(() => []),
}));

import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";

const TEST_COPILOT_TOKEN = "copilot_test_token_abc";
const TEST_BASE_URL = "https://api.githubcopilot.test";

function buildModelsResponse(models: Array<{ id: string; supported_endpoints?: string[] }>) {
  return { data: models };
}

function buildEmbeddingResponse(embeddings: Array<{ embedding: number[]; index: number }>) {
  return { data: embeddings };
}

function mockFetchSequence(
  responses: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>,
) {
  let callIndex = 0;
  fetchWithSsrFGuardMock.mockImplementation(async () => {
    const spec = responses[callIndex++];
    if (!spec) {
      throw new Error(`Unexpected fetchWithSsrFGuard call #${callIndex}`);
    }
    return {
      response: {
        ok: spec.ok,
        status: spec.status ?? (spec.ok ? 200 : 500),
        json: async () => spec.json,
        text: async () => spec.text ?? "",
      },
      release: vi.fn(async () => {}),
    };
  });
}

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    resolveFirstGithubTokenMock.mockReturnValue({
      githubToken: "gh_test_token_123",
      hasProfile: false,
    });
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: TEST_COPILOT_TOKEN,
      expiresAt: Date.now() + 3_600_000,
      source: "test",
      baseUrl: TEST_BASE_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveFirstGithubTokenMock.mockReset();
    resolveCopilotApiTokenMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
  });

  describe("adapter properties", () => {
    it("has correct id", () => {
      expect(githubCopilotMemoryEmbeddingProviderAdapter.id).toBe("github-copilot");
    });

    it("has transport set to remote", () => {
      expect(githubCopilotMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    });

    it("has autoSelectPriority of 15", () => {
      expect(githubCopilotMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(15);
    });

    it("allows explicit override when configured auto", () => {
      expect(githubCopilotMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(
        true,
      );
    });
  });

  describe("model discovery", () => {
    it("picks text-embedding-3-small when available", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-large", supported_endpoints: ["/v1/embeddings"] },
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
            { id: "text-embedding-ada-002", supported_endpoints: ["/v1/embeddings"] },
            { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.provider?.model).toBe("text-embedding-3-small");
    });

    it("falls back to text-embedding-3-large when small is unavailable", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-large", supported_endpoints: ["/v1/embeddings"] },
            { id: "text-embedding-ada-002", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.provider?.model).toBe("text-embedding-3-large");
    });

    it("filters models by embedding endpoint support", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.provider?.model).toBe("text-embedding-3-small");
    });

    it("discovers models by ID when supported_endpoints is empty", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
            { id: "text-embedding-3-small", supported_endpoints: [] },
            { id: "text-embedding-ada-002" },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.provider?.model).toBe("text-embedding-3-small");
    });

    it("picks first available model when no preferred model is available", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "custom-embedding-v1", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.provider?.model).toBe("custom-embedding-v1");
    });
  });

  describe("user-configured model", () => {
    it("uses user-configured model override", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
            { id: "custom-model", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result = await githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        model: "custom-model",
      } as never);

      expect(result.provider?.model).toBe("custom-model");
    });

    it("strips github-copilot/ prefix from user model", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result = await githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        model: "github-copilot/text-embedding-3-small",
      } as never);

      expect(result.provider?.model).toBe("text-embedding-3-small");
    });

    it("throws when user model is not in discovered list", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      await expect(
        githubCopilotMemoryEmbeddingProviderAdapter.create({
          ...defaultCreateOptions(),
          model: "gpt-4o",
        } as never),
      ).rejects.toThrow('GitHub Copilot embedding model "gpt-4o" is not available');
    });

    it("throws when user model is set but no embedding models are discovered", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
          ]),
        },
      ]);

      await expect(
        githubCopilotMemoryEmbeddingProviderAdapter.create({
          ...defaultCreateOptions(),
          model: "text-embedding-3-small",
        } as never),
      ).rejects.toThrow("No embedding models available from GitHub Copilot");
    });
  });

  describe("error handling", () => {
    it("throws when no embedding models are available", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
          ]),
        },
      ]);

      await expect(
        githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
      ).rejects.toThrow("No embedding models available from GitHub Copilot");
    });

    it("throws when model discovery returns HTTP error", async () => {
      mockFetchSequence([
        {
          ok: false,
          status: 401,
          text: "Unauthorized",
        },
      ]);

      await expect(
        githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
      ).rejects.toThrow("GitHub Copilot model discovery HTTP 401");
    });

    it("throws when no GitHub token is available", async () => {
      resolveFirstGithubTokenMock.mockReturnValue({
        githubToken: "",
        hasProfile: false,
      });

      await expect(
        githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
      ).rejects.toThrow("No GitHub token available");
    });

    it("throws when embeddings endpoint returns HTTP error", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
        { ok: false, status: 429, text: "Rate limit exceeded" },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      await expect(result.provider!.embedQuery("hello")).rejects.toThrow(
        "GitHub Copilot embeddings HTTP 429",
      );
    });

    it("throws when embeddings response is malformed", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
        { ok: true, json: { model: "text-embedding-3-small" } },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      await expect(result.provider!.embedQuery("hello")).rejects.toThrow(
        "GitHub Copilot embeddings response missing data[]",
      );
    });
  });

  describe("shouldContinueAutoSelection", () => {
    it("returns true for missing GitHub token errors", () => {
      const err = new Error("No GitHub token available for Copilot embedding provider");
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        true,
      );
    });

    it("returns true for token exchange failures", () => {
      const err = new Error("Copilot token exchange failed: HTTP 401");
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        true,
      );
    });

    it("returns true for no embedding models available", () => {
      const err = new Error("No embedding models available from GitHub Copilot");
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        true,
      );
    });

    it("returns true for model discovery failures", () => {
      const err = new Error("GitHub Copilot model discovery HTTP 403: Forbidden");
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        true,
      );
    });

    it("returns true for user model not available", () => {
      const err = new Error(
        'GitHub Copilot embedding model "gpt-4o" is not available. Available: text-embedding-3-small',
      );
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        true,
      );
    });

    it("returns false for non-Copilot errors", () => {
      const err = new Error("Network timeout");
      expect(githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!(err)).toBe(
        false,
      );
    });

    it("returns false for non-Error values", () => {
      expect(
        githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection!("some string"),
      ).toBe(false);
    });
  });

  describe("embedQuery", () => {
    it("calls the endpoint and returns a vector", async () => {
      const embedding = [0.1, 0.2, 0.3];
      const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      const normalized = embedding.map((v) => v / magnitude);

      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
        {
          ok: true,
          json: buildEmbeddingResponse([{ embedding, index: 0 }]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      const vector = await result.provider!.embedQuery("hello world");

      expect(vector).toEqual(normalized);

      // Verify the embeddings call used POST with correct body (second fetch call)
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
      const embeddingsCall = fetchWithSsrFGuardMock.mock.calls[1][0] as {
        url: string;
        init: { method: string; body: string };
      };
      expect(embeddingsCall.url).toBe(`${TEST_BASE_URL}/embeddings`);
      expect(embeddingsCall.init.method).toBe("POST");
      const body = JSON.parse(embeddingsCall.init.body) as { model: string; input: string[] };
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.input).toEqual(["hello world"]);
    });
  });

  describe("embedBatch", () => {
    it("returns multiple vectors sorted by index", async () => {
      const emb0 = [0.1, 0.2, 0.3];
      const emb1 = [0.4, 0.5, 0.6];

      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
        {
          ok: true,
          // Return in reverse index order to verify sorting
          json: buildEmbeddingResponse([
            { embedding: emb1, index: 1 },
            { embedding: emb0, index: 0 },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      const vectors = await result.provider!.embedBatch(["first", "second"]);

      expect(vectors).toHaveLength(2);
      // Verify order matches input order (index 0 first, index 1 second)
      const mag0 = Math.sqrt(emb0.reduce((sum, v) => sum + v * v, 0));
      const mag1 = Math.sqrt(emb1.reduce((sum, v) => sum + v * v, 0));
      expect(vectors[0]).toEqual(emb0.map((v) => v / mag0));
      expect(vectors[1]).toEqual(emb1.map((v) => v / mag1));
    });

    it("returns empty array for empty input", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
      const vectors = await result.provider!.embedBatch([]);

      expect(vectors).toEqual([]);
      // No extra fetch call for empty input
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("runtime", () => {
    it("includes cache key data with provider, baseUrl, and model", async () => {
      mockFetchSequence([
        {
          ok: true,
          json: buildModelsResponse([
            { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
          ]),
        },
      ]);

      const result =
        await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

      expect(result.runtime).toBeDefined();
      expect(result.runtime!.id).toBe("github-copilot");
      expect(result.runtime!.cacheKeyData).toEqual({
        provider: "github-copilot",
        baseUrl: TEST_BASE_URL,
        model: "text-embedding-3-small",
      });
    });
  });
});
