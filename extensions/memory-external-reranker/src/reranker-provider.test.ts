import type { RerankDocument } from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGuardMock } = vi.hoisted(() => ({
  fetchGuardMock: vi.fn(),
}));

import {
  DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS,
  ExternalMmrReranker,
  setExternalRerankerFetchGuardForTesting,
} from "./reranker.js";

afterEach(() => {
  setExternalRerankerFetchGuardForTesting(null);
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a minimal mock OpenClawConfig for tests. */
function makeTestConfig(providers: Record<string, { baseUrl: string; apiKey?: unknown }>) {
  return { models: { providers } } as never;
}

function mockOkGuard(results: Array<{ index: number; relevance_score: number }>) {
  fetchGuardMock.mockResolvedValue({
    response: new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => {}),
    finalUrl: "http://mock-final-url",
  });
  setExternalRerankerFetchGuardForTesting(fetchGuardMock);
  return fetchGuardMock;
}

function guardCallOpts(
  fn: ReturnType<typeof vi.fn>,
  index = 0,
): Parameters<typeof fetchWithSsrFGuard>[0] {
  return fn.mock.calls[index]?.[0] as Parameters<typeof fetchWithSsrFGuard>[0];
}

function guardCallBody(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const opts = guardCallOpts(fn, index);
  return JSON.parse(opts.init?.body as string) as Record<string, unknown>;
}

const sampleDocs: RerankDocument[] = [
  { id: "doc-1", content: "machine learning neural networks", score: 0.8 },
  { id: "doc-2", content: "database sql queries", score: 0.6 },
  { id: "doc-3", content: "machine learning algorithms", score: 0.4 },
];

describe("ExternalMmrReranker", () => {
  describe("single model", () => {
    it("sends one fetch to provider baseUrl + endpointPath with correct body", async () => {
      const mock = mockOkGuard([
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
        { index: 2, relevance_score: 0.3 },
      ]);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3" },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      await reranker.rerank({ query: "neural networks", documents: sampleDocs, limit: 10 });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(guardCallOpts(mock).url).toBe("http://localhost:8080/v1/rerank");
      expect(guardCallOpts(mock).timeoutMs).toBe(DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS);
      expect(guardCallBody(mock)).toMatchObject({
        query: "neural networks",
        documents: [
          "machine learning neural networks",
          "database sql queries",
          "machine learning algorithms",
        ],
        top_n: 10,
        model: "qwen3",
      });
    });
  });

  describe("modelFallbacks fallthrough", () => {
    it("tries next candidate when first provider returns non-ok", async () => {
      let callCount = 0;
      const mockFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            response: new Response("Service Unavailable", { status: 503 }),
            release: vi.fn(async () => {}),
            finalUrl: "http://mock-final-url",
          };
        }
        return {
          response: new Response(
            JSON.stringify({ results: [{ index: 0, relevance_score: 0.7 }] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
          release: vi.fn(async () => {}),
          finalUrl: "http://mock-final-url",
        };
      });
      setExternalRerankerFetchGuardForTesting(mockFn);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3", modelFallbacks: ["qwen3-large"] },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 5 });

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(guardCallOpts(mockFn, 0).url).toBe("http://localhost:8080/v1/rerank");
      expect(guardCallOpts(mockFn, 1).url).toBe("http://localhost:8080/v1/rerank");
      expect(guardCallBody(mockFn, 0)).toMatchObject({ model: "qwen3" });
      expect(guardCallBody(mockFn, 1)).toMatchObject({ model: "qwen3-large" });
    });
  });

  describe("all-fail aggregation", () => {
    it("throws error mentioning all failed candidates after all exhausted", async () => {
      let callCount = 0;
      const mockFn = vi.fn(async () => {
        callCount++;
        return {
          response: new Response(`provider ${callCount} error`, { status: 500 }),
          release: vi.fn(async () => {}),
          finalUrl: "http://mock-final-url",
        };
      });
      setExternalRerankerFetchGuardForTesting(mockFn);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3", modelFallbacks: ["gpt-rerank"] },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await expect(reranker.rerank({ query: "test", documents: docs, limit: 5 })).rejects.toThrow(
        /qwen3.*gpt-rerank/,
      );
    });
  });

  describe("endpointPath override", () => {
    it("uses custom endpointPath instead of /v1/rerank", async () => {
      const mock = mockOkGuard([{ index: 0, relevance_score: 0.8 }]);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3", endpointPath: "/rerank" },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 5 });

      expect(guardCallOpts(mock).url).toBe("http://localhost:8080/rerank");
    });
  });

  describe("topN cap", () => {
    it("sends topN from config as top_n even when limit is larger", async () => {
      const mock = mockOkGuard([{ index: 0, relevance_score: 0.8 }]);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3", topN: 3 },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 10 });

      expect(guardCallBody(mock)).toMatchObject({ top_n: 3 });
    });
  });

  describe("score mapping and id preservation", () => {
    it("maps relevance_score to result score and preserves original document id by index", async () => {
      mockOkGuard([
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.72 },
      ]);

      const reranker = new ExternalMmrReranker(
        { provider: "llamacpp", model: "qwen3" },
        makeTestConfig({ llamacpp: { baseUrl: "http://localhost:8080" } }),
      );

      const docs: RerankDocument[] = [
        { id: "doc-alpha", content: "first document", score: 0.5 },
        { id: "doc-beta", content: "second document", score: 0.5 },
      ];
      const result = await reranker.rerank({ query: "test", documents: docs, limit: 5 });

      expect(result).toEqual([
        { id: "doc-beta", score: 0.95 },
        { id: "doc-alpha", score: 0.72 },
      ]);
    });
  });
});
