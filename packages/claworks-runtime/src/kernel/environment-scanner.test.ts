import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentScanner, resolveOriosearchBaseUrl } from "./environment-scanner.js";

describe("resolveOriosearchBaseUrl", () => {
  afterEach(() => {
    delete process.env.CLAWORKS_ORIOSEARCH_URL;
    delete process.env.ORIOSEARCH_URL;
  });

  it("prefers CLAWORKS_ORIOSEARCH_URL and strips trailing slash", () => {
    process.env.CLAWORKS_ORIOSEARCH_URL = "http://127.0.0.1:8000/";
    expect(resolveOriosearchBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("falls back to ORIOSEARCH_URL", () => {
    process.env.ORIOSEARCH_URL = "http://localhost:8000";
    expect(resolveOriosearchBaseUrl()).toBe("http://localhost:8000");
  });
});

describe("createEnvironmentScanner().webSearch", () => {
  afterEach(() => {
    delete process.env.CLAWORKS_ORIOSEARCH_URL;
    delete process.env.SEARXNG_URL;
    vi.unstubAllGlobals();
  });

  it("calls OrioSearch Tavily-compatible /search endpoint", async () => {
    process.env.CLAWORKS_ORIOSEARCH_URL = "http://127.0.0.1:8000";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "A", url: "https://a.test", content: "snippet A" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const scanner = createEnvironmentScanner();
    const results = await scanner.webSearch("test query", 3);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "test query", max_results: 3 }),
      }),
    );
    expect(results).toEqual([{ title: "A", url: "https://a.test", snippet: "snippet A" }]);
  });
});
