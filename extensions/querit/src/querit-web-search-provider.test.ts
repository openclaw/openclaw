import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./querit-web-search-provider.js";

describe("querit web search provider", () => {
  beforeEach(() => {
    delete process.env.QUERIT_API_KEY;
  });

  afterEach(() => {
    delete process.env.QUERIT_API_KEY;
  });

  describe("resolveQueritConfig", () => {
    it("returns empty object when no search config", () => {
      expect(__testing.resolveQueritConfig(undefined)).toEqual({});
    });

    it("returns empty object when querit key is missing", () => {
      expect(__testing.resolveQueritConfig({ perplexity: { apiKey: "pplx-test" } })).toEqual({});
    });

    it("returns querit sub-config when present", () => {
      const config = { querit: { apiKey: "querit-sk-test" } };
      expect(__testing.resolveQueritConfig(config)).toEqual({ apiKey: "querit-sk-test" });
    });
  });

  describe("resolveQueritApiKey", () => {
    it("returns undefined when no config and no env", () => {
      expect(__testing.resolveQueritApiKey({})).toBeUndefined();
    });

    it("reads from env var QUERIT_API_KEY", () => {
      process.env.QUERIT_API_KEY = "querit-sk-from-env";
      expect(__testing.resolveQueritApiKey({})).toBe("querit-sk-from-env");
    });

    it("reads from config apiKey", () => {
      expect(__testing.resolveQueritApiKey({ apiKey: "querit-sk-config" })).toBe(
        "querit-sk-config",
      );
    });

    it("config takes priority over env", () => {
      process.env.QUERIT_API_KEY = "querit-sk-from-env";
      expect(__testing.resolveQueritApiKey({ apiKey: "querit-sk-config" })).toBe(
        "querit-sk-config",
      );
    });
  });

  describe("mapQueritResult", () => {
    it("populates published from a bare date page_age", () => {
      const result = __testing.mapQueritResult({
        title: "Example",
        url: "https://example.com",
        snippet: "A snippet.",
        page_age: "2025-11-14",
      });
      expect(result.published).toBe("2025-11-14");
    });

    it("populates published from a full timestamp page_age", () => {
      const result = __testing.mapQueritResult({
        title: "Example",
        url: "https://example.com",
        snippet: "A snippet.",
        page_age: "2025-07-20T16:00:00Z",
      });
      expect(result.published).toBe("2025-07-20");
    });

    it("omits published when page_age is absent", () => {
      const result = __testing.mapQueritResult({
        title: "Example",
        url: "https://example.com",
        snippet: "A snippet.",
      });
      expect(result).not.toHaveProperty("published");
    });
  });
});
