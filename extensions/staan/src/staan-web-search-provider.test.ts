import { describe, expect, it, vi } from "vitest";
import { createStaanWebSearchProvider as createContractStaanWebSearchProvider } from "../web-search-contract-api.js";
import { createStaanWebSearchProvider } from "./staan-web-search-provider.js";

type JsonRecord = Record<string, unknown>;

function requireStaanTool(webSearch: JsonRecord, searchConfig: JsonRecord = {}) {
  const tool = createStaanWebSearchProvider().createTool({
    config: { plugins: { entries: { staan: { config: { webSearch } } } } },
    searchConfig,
  } as never);
  if (!tool) {
    throw new Error("Expected Staan tool definition");
  }
  return tool;
}

function staanResponse(results: unknown[]) {
  return new Response(JSON.stringify({ search_id: "s1", query: "q", web: { results } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("staan web search provider", () => {
  it("exposes the same factory through the contract api", () => {
    expect(createContractStaanWebSearchProvider().id).toBe("staan");
  });

  it("reports a missing API key instead of calling the endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const tool = requireStaanTool({});
      const result = (await tool.execute({ query: "staan" }, {})) as JsonRecord;
      expect(result.error).toBe("missing_staan_api_key");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("posts the query with the default market and maps results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      staanResponse([
        {
          title: "Result one",
          url: "https://example.com/one",
          snippet: "First snippet",
          hostname: "example.com",
        },
      ]),
    );
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      const result = (await tool.execute({ query: "european search" }, {})) as JsonRecord;

      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe("https://api.staan.ai/v2/search/web");
      const body = JSON.parse(String((init as RequestInit).body)) as JsonRecord;
      expect(body.q).toBe("european search");
      expect(body.market).toBe("en-gb");

      expect(result.provider).toBe("staan");
      const results = result.results as JsonRecord[];
      expect(results).toHaveLength(1);
      expect(results[0]?.url).toBe("https://example.com/one");
      expect(results[0]?.siteName).toBe("example.com");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects a market the API does not accept", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      // en-uk is what Staan's public docs advertise; the API only accepts en-gb.
      const result = (await tool.execute({ query: "q", market: "en-uk" }, {})) as JsonRecord;
      expect(result.error).toBe("invalid_market");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses the configured default market when the caller omits one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(staanResponse([]));
    try {
      const tool = requireStaanTool({ apiKey: "stn_test", market: "fr-fr" });
      await tool.execute({ query: "conciergerie" }, {});
      const body = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
      ) as JsonRecord;
      expect(body.market).toBe("fr-fr");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("maps scored passages when extra_snippets is requested", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      staanResponse([
        {
          title: "Scored",
          url: "https://example.com/scored",
          snippet: "base",
          extra_snippets: [
            { chunk: "high relevance passage", score: 0.97 },
            { chunk: "", score: 0.4 },
          ],
        },
      ]),
    );
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      const result = (await tool.execute(
        { query: "q", extra_snippets: true, max_snippets: 5, min_score: 0.2 },
        {},
      )) as JsonRecord;

      const body = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
      ) as JsonRecord;
      expect(body.extra_snippets).toBe(true);
      expect(body.max_snippets).toBe(5);
      expect(body.min_score).toBe(0.2);

      const first = (result.results as JsonRecord[])[0] as JsonRecord;
      const snippets = first.snippets as JsonRecord[];
      // The empty chunk is dropped rather than emitted as a blank passage.
      expect(snippets).toHaveLength(1);
      expect(snippets[0]?.score).toBe(0.97);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("trims the fixed ten-result page to the requested count", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      title: `r${index}`,
      url: `https://example.com/${index}`,
      snippet: "s",
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(staanResponse(many));
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      const result = (await tool.execute({ query: "q", count: 3 }, {})) as JsonRecord;
      expect(result.count).toBe(3);
      expect(result.results as JsonRecord[]).toHaveLength(3);
      // Staan rejects any count other than 10, so it must not be forwarded.
      const body = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
      ) as JsonRecord;
      expect(body.count).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects more domain filters than the API accepts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      const result = (await tool.execute(
        { query: "q", include_domains: Array.from({ length: 11 }, (_, i) => `d${i}.com`) },
        {},
      )) as JsonRecord;
      expect(result.error).toBe("invalid_domain_filter");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects an invalid base URL before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const tool = requireStaanTool({ apiKey: "stn_test", baseUrl: "ftp://staan.invalid" });
      const result = (await tool.execute({ query: "q" }, {})) as JsonRecord;
      expect(result.error).toBe("invalid_base_url");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("appends the search path to a configured base URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(staanResponse([]));
    try {
      // A public hostname: the SSRF guard rejects private/internal names
      // before the request is built, which is its job but not what this covers.
      const tool = requireStaanTool({ apiKey: "stn_test", baseUrl: "https://proxy.example.com/v2" });
      await tool.execute({ query: "q" }, {});
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://proxy.example.com/v2/search/web",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("surfaces an API error with its status", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bad market", { status: 400 }));
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      await expect(tool.execute({ query: "q" }, {})).rejects.toThrow(/Staan API error \(400\)/);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not send an already canceled search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(staanResponse([]));
    try {
      const tool = requireStaanTool({ apiKey: "stn_test" });
      const controller = new AbortController();
      controller.abort(new Error("Staan caller canceled"));
      await expect(
        tool.execute({ query: "canceled" }, { signal: controller.signal }),
      ).rejects.toThrow("Staan caller canceled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
