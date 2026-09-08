import type {
  MemorySearchResult,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
// Memory Core tests cover the Fred context-service search seam in the manager.
//
// The seam (`__fredContextServiceSearch`) routes memory-corpus searches to an
// external context-service HTTP API because the native sqlite fts5/vec path is
// dead on this deployment. It must: map hits into MemorySearchResult[], only
// serve searches that include the "memory" corpus, and never throw (returning
// undefined so the native body runs instead). We also assert the short-circuit
// wiring in `search()` returns the seam value and otherwise falls through.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexManager } from "./manager.js";

type SeamOpts = {
  maxResults?: number;
  sources?: MemorySource[];
};

type SeamFn = (query: string, opts?: SeamOpts) => Promise<MemorySearchResult[] | undefined>;

type SearchFn = (query: string, opts?: SeamOpts) => Promise<MemorySearchResult[]>;

const seam = (MemoryIndexManager.prototype as unknown as { __fredContextServiceSearch: SeamFn })
  // oxlint-disable-next-line eslint/no-underscore-dangle -- accessing the seam marker method under test.
  .__fredContextServiceSearch;

const searchImpl = (MemoryIndexManager.prototype as unknown as { search: SearchFn }).search;

// The seam never touches `this`, so it can be invoked against an empty object.
function callSeam(query: string, opts?: SeamOpts): Promise<MemorySearchResult[] | undefined> {
  return seam.call({}, query, opts);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FRED_CONTEXT_SERVICE_URL;
});

describe("MemoryIndexManager context-service seam", () => {
  it("maps context-service hits into MemorySearchResult[] on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: [
          { text: "alpha note", source: "MEMORY.md", line: 12, score: 0.9 },
          { text: "beta note", source: "memory/2026-01-01.md", line: 3, score: 0.4 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await callSeam("recall alpha", { maxResults: 5 });

    expect(results).toBeDefined();
    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({
      id: "MEMORY.md:12",
      source: "memory",
      path: "MEMORY.md",
      startLine: 12,
      endLine: 12,
      score: 0.9,
      textScore: 0.9,
      snippet: "alpha note",
      text: "alpha note",
    });
    // Request shape: POST /getContext with hybrid mode and k = maxResults.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://context-service:8090/getContext");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "recall alpha",
      k: 5,
      mode: "hybrid",
    });
  });

  it("applies sane defaults for missing hit fields and respects maxResults limit", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        hits: [
          {}, // fully defaulted
          { text: "x", source: "a.md", line: 2, score: 0.5 },
          { text: "y", source: "b.md", line: 4, score: 0.6 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await callSeam("q", { maxResults: 2 });

    expect(results).toHaveLength(2);
    expect(results?.[0]).toMatchObject({
      id: "memory:1",
      path: "memory",
      startLine: 1,
      endLine: 1,
      score: 0,
      textScore: 0,
      snippet: "",
      text: "",
    });
  });

  it("uses FRED_CONTEXT_SERVICE_URL and strips trailing slashes", async () => {
    process.env.FRED_CONTEXT_SERVICE_URL = "https://ctx.example.com///";
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ hits: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await callSeam("q");

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://ctx.example.com/getContext");
  });

  it("falls through (undefined) when sources exclude the memory corpus", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const results = await callSeam("q", { sources: ["sessions"] });

    expect(results).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves searches that include the memory corpus among sources", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ hits: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await callSeam("q", { sources: ["memory", "sessions"] });

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through (undefined) on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(callSeam("q")).resolves.toBeUndefined();
  });

  it("falls through (undefined) and never throws when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(callSeam("q")).resolves.toBeUndefined();
  });

  it("falls through (undefined) when global fetch is unavailable", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(callSeam("q")).resolves.toBeUndefined();
  });

  it("search() short-circuits and returns the seam result (native path bypassed)", async () => {
    const sentinel: MemorySearchResult[] = [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "hit",
        source: "memory",
      },
    ];
    const seamSpy = vi.fn(async () => sentinel);
    // Minimal fake `this`: search() returns before touching any other member
    // once the seam yields an array.
    const fakeThis = { __fredContextServiceSearch: seamSpy };

    const result = await searchImpl.call(fakeThis as never, "q", {});

    expect(result).toBe(sentinel);
    expect(seamSpy).toHaveBeenCalledTimes(1);
  });

  it("search() falls through to the native body when the seam returns undefined", async () => {
    const seamSpy = vi.fn(async () => undefined);
    // No native members on the fake `this`, so falling through past the
    // short-circuit must reach native code (which then throws). This proves the
    // seam's `undefined` is NOT returned as the search result.
    const fakeThis = { __fredContextServiceSearch: seamSpy };

    await expect(searchImpl.call(fakeThis as never, "q", {})).rejects.toBeInstanceOf(TypeError);
    expect(seamSpy).toHaveBeenCalledTimes(1);
  });
});
