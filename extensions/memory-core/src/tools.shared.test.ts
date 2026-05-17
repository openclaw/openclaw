import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
  type MemoryCorpusSearchResult,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { searchMemoryCorpusSupplements } from "./tools.shared.js";

function makeEngineCandidate(path: string, score: number): MemorySearchResult {
  return {
    path,
    startLine: 1,
    endLine: 5,
    score,
    snippet: `synthetic passage for ${path}`,
    source: "memory",
  };
}

describe("searchMemoryCorpusSupplements engineCandidates passthrough", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("forwards engineCandidates to registered supplements", async () => {
    const received: { engineCandidates?: MemorySearchResult[] }[] = [];
    registerMemoryCorpusSupplement("recorder-plugin", {
      search: async (params) => {
        received.push({ engineCandidates: params.engineCandidates });
        return [];
      },
      get: async () => null,
    });

    const engineCandidates = [
      makeEngineCandidate("docs/a.md", 0.9),
      makeEngineCandidate("docs/b.md", 0.5),
    ];

    await searchMemoryCorpusSupplements({
      query: "test query",
      maxResults: 5,
      agentSessionKey: "agent:main:main",
      corpus: "all",
      engineCandidates,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.engineCandidates).toEqual(engineCandidates);
  });

  it("passes undefined engineCandidates when caller omits the field", async () => {
    const received: { engineCandidates?: MemorySearchResult[] }[] = [];
    registerMemoryCorpusSupplement("recorder-plugin", {
      search: async (params) => {
        received.push({ engineCandidates: params.engineCandidates });
        return [];
      },
      get: async () => null,
    });

    await searchMemoryCorpusSupplements({
      query: "test query",
      maxResults: 5,
      corpus: "all",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.engineCandidates).toBeUndefined();
  });

  it("works with supplements that ignore engineCandidates (back-compat)", async () => {
    // Supplement that produces its own results without consulting
    // engineCandidates — represents the pre-existing pattern (e.g.,
    // compiled wiki corpora). The new field must not break these.
    registerMemoryCorpusSupplement("wiki-style", {
      search: async (): Promise<MemoryCorpusSearchResult[]> => [
        {
          corpus: "wiki",
          path: "sources/alpha.md",
          score: 0.8,
          snippet: "alpha doc",
        },
      ],
      get: async () => null,
    });

    const results = await searchMemoryCorpusSupplements({
      query: "alpha",
      maxResults: 5,
      corpus: "all",
      engineCandidates: [makeEngineCandidate("ignored.md", 0.99)],
    });

    expect(results).toEqual([
      {
        corpus: "wiki",
        path: "sources/alpha.md",
        score: 0.8,
        snippet: "alpha doc",
      },
    ]);
  });

  it("returns early without invoking supplements for corpus=memory|sessions", async () => {
    let invoked = 0;
    registerMemoryCorpusSupplement("recorder-plugin", {
      search: async () => {
        invoked += 1;
        return [];
      },
      get: async () => null,
    });

    await searchMemoryCorpusSupplements({
      query: "test",
      maxResults: 5,
      corpus: "memory",
      engineCandidates: [makeEngineCandidate("a.md", 0.5)],
    });
    await searchMemoryCorpusSupplements({
      query: "test",
      maxResults: 5,
      corpus: "sessions",
      engineCandidates: [makeEngineCandidate("a.md", 0.5)],
    });

    expect(invoked).toBe(0);
  });

  it("allows a reranker-style supplement to reorder engineCandidates", async () => {
    // End-to-end demonstration: a supplement uses engineCandidates to
    // produce its own ranked output without calling manager.search.
    // This is the use case the change exists to enable.
    registerMemoryCorpusSupplement("reranker-style", {
      search: async (params): Promise<MemoryCorpusSearchResult[]> => {
        const candidates = params.engineCandidates ?? [];
        // Reverse the order to demonstrate the supplement is in control.
        return candidates
          .slice()
          .reverse()
          .map(
            (c, i): MemoryCorpusSearchResult => ({
              corpus: "reranker-style",
              path: c.path,
              score: 1 - i * 0.1,
              snippet: c.snippet,
              startLine: c.startLine,
              endLine: c.endLine,
              source: c.source,
              provenanceLabel: "reranker-style",
            }),
          );
      },
      get: async () => null,
    });

    const engineCandidates = [
      makeEngineCandidate("doc-1.md", 0.9),
      makeEngineCandidate("doc-2.md", 0.7),
      makeEngineCandidate("doc-3.md", 0.5),
    ];

    const results = await searchMemoryCorpusSupplements({
      query: "test",
      maxResults: 5,
      corpus: "all",
      engineCandidates,
    });

    // Reversed: doc-3 first, doc-2 second, doc-1 third
    expect(results.map((r) => r.path)).toEqual(["doc-3.md", "doc-2.md", "doc-1.md"]);
    expect(results.every((r) => r.corpus === "reranker-style")).toBe(true);
  });
});
