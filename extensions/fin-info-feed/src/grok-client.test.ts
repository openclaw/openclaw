import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGrokContent,
  parseAnalysisResponse,
  searchKolBatch,
  scanAllKols,
} from "./grok-client.js";

describe("extractGrokContent", () => {
  it("extracts text from message-wrapped output_text block", () => {
    const data = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Hello world",
              annotations: [
                { type: "url_citation", url: "https://x.com/post/1" },
                { type: "url_citation", url: "https://x.com/post/2" },
                { type: "url_citation", url: "https://x.com/post/1" }, // duplicate
              ],
            },
          ],
        },
      ],
    };
    const result = extractGrokContent(data);
    expect(result.text).toBe("Hello world");
    expect(result.citations).toEqual(["https://x.com/post/1", "https://x.com/post/2"]);
  });

  it("extracts text from direct output_text block", () => {
    const data = {
      output: [
        {
          type: "output_text",
          text: "Direct content",
          annotations: [{ type: "url_citation", url: "https://example.com" }],
        },
      ],
    };
    const result = extractGrokContent(data);
    expect(result.text).toBe("Direct content");
    expect(result.citations).toEqual(["https://example.com"]);
  });

  it("falls back to deprecated output_text field", () => {
    const data = {
      output_text: "Legacy text",
      citations: ["https://legacy.com"],
    };
    const result = extractGrokContent(data);
    expect(result.text).toBe("Legacy text");
    expect(result.citations).toEqual(["https://legacy.com"]);
  });

  it("returns undefined text when output is empty", () => {
    const result = extractGrokContent({ output: [] });
    expect(result.text).toBeUndefined();
    expect(result.citations).toEqual([]);
  });
});

describe("parseAnalysisResponse", () => {
  it("parses valid JSON array from raw text", () => {
    const raw = JSON.stringify([
      {
        handle: "CryptoHayes",
        title: "BTC to 100k",
        summary: "Arthur predicts BTC rally",
        score: 8,
        category: "crypto",
        sentiment: "bullish",
        symbols: ["BTC"],
        urls: ["https://x.com/cryptohayes/1"],
      },
    ]);
    const items = parseAnalysisResponse(raw, [], "x_search");
    expect(items).toHaveLength(1);
    expect(items[0]!.handle).toBe("CryptoHayes");
    expect(items[0]!.score).toBe(8);
    expect(items[0]!.sentiment).toBe("bullish");
    expect(items[0]!.symbols).toEqual(["BTC"]);
  });

  it("handles markdown code fences", () => {
    const raw = '```json\n[{"handle":"test","title":"News","score":6,"category":"macro"}]\n```';
    const items = parseAnalysisResponse(raw, ["https://cite.com"], "x_search");
    expect(items).toHaveLength(1);
    expect(items[0]!.handle).toBe("test");
    // Citations from outer call should be merged
    expect(items[0]!.sourceUrls).toContain("https://cite.com");
  });

  it("clamps score to 1-10 range", () => {
    const raw = JSON.stringify([
      { handle: "a", title: "t", score: 15, category: "x" },
      { handle: "b", title: "t", score: -3, category: "x" },
      { handle: "c", title: "t", score: 0, category: "x" },
    ]);
    const items = parseAnalysisResponse(raw, [], "x_search");
    expect(items[0]!.score).toBe(10);
    expect(items[1]!.score).toBe(1);
    // score 0 is falsy → defaults to 5 via `|| 5`, then clamped to [1,10]
    expect(items[2]!.score).toBe(5);
  });

  it("defaults sentiment to neutral for invalid values", () => {
    const raw = JSON.stringify([{ handle: "x", title: "t", score: 5, sentiment: "invalid" }]);
    const items = parseAnalysisResponse(raw, [], "x_search");
    expect(items[0]!.sentiment).toBe("neutral");
  });

  it("returns empty array for non-JSON text", () => {
    const items = parseAnalysisResponse("This is not JSON at all.", [], "x_search");
    expect(items).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    const items = parseAnalysisResponse('{"broken": true', [], "x_search");
    expect(items).toEqual([]);
  });

  it("extracts JSON array embedded in other text", () => {
    const raw = 'Here are the results: [{"handle":"embedded","title":"Found","score":7}] and more text';
    const items = parseAnalysisResponse(raw, [], "x_search");
    expect(items).toHaveLength(1);
    expect(items[0]!.handle).toBe("embedded");
  });

  it("truncates long title and summary", () => {
    const raw = JSON.stringify([{
      handle: "test",
      title: "A".repeat(300),
      summary: "B".repeat(600),
      score: 5,
    }]);
    const items = parseAnalysisResponse(raw, [], "x_search");
    expect(items[0]!.title.length).toBeLessThanOrEqual(200);
    expect(items[0]!.summary.length).toBeLessThanOrEqual(500);
  });
});

describe("searchKolBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends correct request body with x_search tool", async () => {
    const mockResponse = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "[]", annotations: [] }],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchKolBatch({
      apiKey: "test-key",
      model: "grok-4-1-fast",
      handles: ["elonmusk", "CryptoHayes"],
      topic: "crypto markets",
      fromDate: "2026-03-01",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("grok-4-1-fast");

    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.type).toBe("x_search");
    expect(tools[0]!.allowed_x_handles).toEqual(["elonmusk", "CryptoHayes"]);
    expect(tools[0]!.from_date).toBe("2026-03-01");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("returns empty array for empty handles", async () => {
    const result = await searchKolBatch({
      apiKey: "key",
      model: "m",
      handles: [],
    });
    expect(result).toEqual([]);
  });

  it("throws for more than 10 handles", async () => {
    const handles = Array.from({ length: 11 }, (_, i) => `user${i}`);
    await expect(
      searchKolBatch({ apiKey: "key", model: "m", handles }),
    ).rejects.toThrow("max 10 handles");
  });

  it("throws on API error response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchKolBatch({ apiKey: "key", model: "m", handles: ["test"] }),
    ).rejects.toThrow("xAI API error (429)");
  });
});

describe("scanAllKols", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("splits handles into batches of 10", async () => {
    const mockResponse = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "[]", annotations: [] }] },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    const handles = Array.from({ length: 23 }, (_, i) => `user${i}`);
    const result = await scanAllKols({ apiKey: "key", model: "m", handles });

    expect(fetchMock).toHaveBeenCalledTimes(3); // 10 + 10 + 3
    expect(result.batchCount).toBe(3);
    expect(result.totalHandles).toBe(23);
  });

  it("deduplicates handles (case-insensitive, strips @)", async () => {
    const mockResponse = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "[]", annotations: [] }] },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    await scanAllKols({
      apiKey: "key",
      model: "m",
      handles: ["@ElonMusk", "elonmusk", "ELONMUSK", "other"],
    });

    // Should be 2 unique handles → 1 batch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]!.allowed_x_handles).toEqual(["elonmusk", "other"]);
  });

  it("deduplicates items by handle+title", async () => {
    const items = JSON.stringify([
      { handle: "test", title: "Same Title", score: 8, category: "crypto" },
      { handle: "test", title: "Same Title", score: 7, category: "crypto" },
      { handle: "test", title: "Different", score: 6, category: "macro" },
    ]);
    const mockResponse = {
      output: [
        { type: "message", content: [{ type: "output_text", text: items, annotations: [] }] },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanAllKols({ apiKey: "key", model: "m", handles: ["test"] });
    expect(result.items).toHaveLength(2); // deduplicated
  });
});
