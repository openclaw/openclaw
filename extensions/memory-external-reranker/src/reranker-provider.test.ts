import type { RerankDocument } from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalMmrReranker } from "./reranker.js";

const priorFetch = global.fetch;

afterEach(() => {
  global.fetch = priorFetch;
  vi.unstubAllEnvs();
});

function mockOkFetch(results: Array<{ index: number; relevance_score: number }>) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
    text: async () => "",
  }));
  global.fetch = fn as unknown as typeof global.fetch;
  return fn;
}

function fetchCallUrl(fn: ReturnType<typeof vi.fn>, index = 0): string {
  return String((fn.mock.calls[index] as [string, RequestInit])[0]);
}

function fetchCallBody(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = (fn.mock.calls[index] as [string, RequestInit])[1];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const sampleDocs: RerankDocument[] = [
  { id: "doc-1", content: "machine learning neural networks", score: 0.8 },
  { id: "doc-2", content: "database sql queries", score: 0.6 },
  { id: "doc-3", content: "machine learning algorithms", score: 0.4 },
];

describe("ExternalMmrReranker", () => {
  describe("single model", () => {
    it("sends one fetch to provider baseUrl + endpointPath with correct body", async () => {
      const mock = mockOkFetch([
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
        { index: 2, relevance_score: 0.3 },
      ]);

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        providers: { llamacpp: { baseUrl: "http://localhost:8080" } },
      });

      await reranker.rerank({ query: "neural networks", documents: sampleDocs, limit: 10 });

      expect(mock).toHaveBeenCalledTimes(1);
      expect(fetchCallUrl(mock)).toBe("http://localhost:8080/v1/rerank");
      expect(fetchCallBody(mock)).toMatchObject({
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
            ok: false,
            status: 503,
            text: async () => "Service Unavailable",
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ index: 0, relevance_score: 0.7 }] }),
          text: async () => "",
        };
      });
      global.fetch = mockFn as unknown as typeof global.fetch;

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        modelFallbacks: ["openai/text-reranker"],
        providers: {
          llamacpp: { baseUrl: "http://localhost:8080" },
          openai: { baseUrl: "https://api.openai.com" },
        },
      });

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 5 });

      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(fetchCallUrl(mockFn, 0)).toBe("http://localhost:8080/v1/rerank");
      expect(fetchCallUrl(mockFn, 1)).toBe("https://api.openai.com/v1/rerank");
    });
  });

  describe("all-fail aggregation", () => {
    it("throws error mentioning all failed candidates after all exhausted", async () => {
      let callCount = 0;
      const mockFn = vi.fn(async () => {
        callCount++;
        return {
          ok: false,
          status: 500,
          text: async () => `provider ${callCount} error`,
          json: async () => ({}),
        };
      });
      global.fetch = mockFn as unknown as typeof global.fetch;

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        modelFallbacks: ["openai/gpt-rerank"],
        providers: {
          llamacpp: { baseUrl: "http://localhost:8080" },
          openai: { baseUrl: "https://api.openai.com" },
        },
      });

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await expect(reranker.rerank({ query: "test", documents: docs, limit: 5 })).rejects.toThrow(
        /llamacpp\/qwen3.*openai\/gpt-rerank/,
      );
    });
  });

  describe("endpointPath override", () => {
    it("uses custom endpointPath instead of /v1/rerank", async () => {
      const mock = mockOkFetch([{ index: 0, relevance_score: 0.8 }]);

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        endpointPath: "/rerank",
        providers: { llamacpp: { baseUrl: "http://localhost:8080" } },
      });

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 5 });

      expect(fetchCallUrl(mock)).toBe("http://localhost:8080/rerank");
    });
  });

  describe("topN cap", () => {
    it("sends topN from config as top_n even when limit is larger", async () => {
      const mock = mockOkFetch([{ index: 0, relevance_score: 0.8 }]);

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        topN: 3,
        providers: { llamacpp: { baseUrl: "http://localhost:8080" } },
      });

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await reranker.rerank({ query: "test", documents: docs, limit: 10 });

      expect(fetchCallBody(mock)).toMatchObject({ top_n: 3 });
    });
  });

  describe("score mapping and id preservation", () => {
    it("maps relevance_score to result score and preserves original document id by index", async () => {
      mockOkFetch([
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.72 },
      ]);

      const reranker = new ExternalMmrReranker({
        model: "llamacpp/qwen3",
        providers: { llamacpp: { baseUrl: "http://localhost:8080" } },
      });

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
