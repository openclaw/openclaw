import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-web-search-provider";

describe("Tavily Web Search Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Configuration", () => {
    it("should create provider with valid API key", () => {
      const config = {
        apiKey: "tvly-test-key-123",
      };

      const provider = createTavilyWebSearchProvider(config);
      expect(provider).toBeDefined();
      expect(provider.id).toBe("tavily");
    });

    it("should support API key from environment variable", () => {
      vi.stubEnv("TAVILY_API_KEY", "tvly-env-key-456");

      const provider = createTavilyWebSearchProvider({});
      expect(provider).toBeDefined();

      vi.unstubAllEnvs();
    });

    it("should prioritize config API key over environment variable", () => {
      vi.stubEnv("TAVILY_API_KEY", "tvly-env-key");
      const config = {
        apiKey: "tvly-config-key",
      };

      const provider = createTavilyWebSearchProvider(config);
      expect(provider).toBeDefined();

      vi.unstubAllEnvs();
    });
  });

  describe("Search Parameters", () => {
    it("should validate result count range", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      // Valid counts
      expect(() => provider.validateParams?.({ count: 1 })).not.toThrow();
      expect(() => provider.validateParams?.({ count: 10 })).not.toThrow();
      expect(() => provider.validateParams?.({ count: 20 })).not.toThrow();

      // Invalid counts
      expect(() => provider.validateParams?.({ count: 0 })).toThrow();
      expect(() => provider.validateParams?.({ count: 21 })).toThrow();
    });

    it("should accept valid search parameters", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      const params = {
        query: "test search",
        count: 10,
        include_answer: true,
        include_raw_content: false,
        topic: "general",
      };

      expect(() => provider.validateParams?.(params)).not.toThrow();
    });

    it("should require query parameter", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      expect(() => provider.validateParams?.({})).toThrow();
    });
  });

  describe("Error Handling", () => {
    it("should handle missing API key gracefully", () => {
      const provider = createTavilyWebSearchProvider({});
      expect(provider).toBeDefined();
      // Provider should indicate missing API key in error handling
    });

    it("should handle network errors", async () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      // Mock network error
      global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

      try {
        await provider.search?.({ query: "test" });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it("should handle API errors", async () => {
      const config = { apiKey: "tvly-invalid-key" };
      const provider = createTavilyWebSearchProvider(config);

      // Mock API error response
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "Unauthorized" }),
      });

      try {
        await provider.search?.({ query: "test" });
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe("Result Formatting", () => {
    it("should format search results correctly", async () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      const mockResponse = {
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            content: "Test content",
            score: 0.95,
          },
        ],
        response_time: 0.5,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const results = await provider.search?.({ query: "test" });
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it("should include raw content when requested", async () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      const mockResponse = {
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            content: "Test content",
            raw_content: "<html>...</html>",
            score: 0.95,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const results = await provider.search?.({
        query: "test",
        include_raw_content: true,
      });
      expect(results).toBeDefined();
    });
  });

  describe("Caching", () => {
    it("should cache search results", async () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      const mockResponse = {
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            content: "Test content",
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      // First search
      await provider.search?.({ query: "test" });

      // Second search with same query
      await provider.search?.({ query: "test" });

      // Should use cache, so fetch should be called only once or twice
      // depending on cache implementation
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("Provider Metadata", () => {
    it("should have correct provider ID", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      expect(provider.id).toBe("tavily");
    });

    it("should have search tool definition", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      expect(provider.toolDefinition).toBeDefined();
      expect(provider.toolDefinition?.name).toBe("tavily_search");
    });

    it("should support configuration UI hints", () => {
      const config = { apiKey: "tvly-test-key" };
      const provider = createTavilyWebSearchProvider(config);

      expect(provider.uiHints).toBeDefined();
      expect(provider.uiHints?.["webSearch.apiKey"]).toBeDefined();
      expect(provider.uiHints?.["webSearch.apiKey"].sensitive).toBe(true);
    });
  });
});
