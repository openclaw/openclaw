import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemorySearchManagerMockConfigs,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemorySearchImpl,
} from "./memory-tool-manager-mock.js";

// Bypass session visibility filtering so corpus-surfacing tests can exercise
// the source -> corpus mapping even without a real session guard. Visibility
// is covered separately by session-search-visibility tests. (#72885)
vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: async (params: { hits: unknown }) => params.hits,
}));

import { createMemorySearchTool } from "./tools.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("returns structured search debug metadata for qmd results", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async (opts) => {
      opts?.onDebug?.({
        backend: "qmd",
        configuredMode: opts.qmdSearchModeOverride ?? "query",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
      });
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "ramen",
          source: "memory",
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "search",
                },
              },
            },
          },
        },
        memory: {
          backend: "qmd",
          qmd: {
            searchMode: "query",
            limits: {
              maxInjectedChars: 1000,
            },
          },
        },
      },
      agentSessionKey: "agent:main:main:active-memory:debug",
    });
    const result = await tool.execute("debug", { query: "favorite food" });
    expect(result.details).toMatchObject({
      mode: "query",
      debug: {
        backend: "qmd",
        configuredMode: "search",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
        hits: 1,
      },
    });
    expect((result.details as { debug?: { searchMs?: number } }).debug?.searchMs).toEqual(
      expect.any(Number),
    );
  });

  it("re-resolves config when executing a previously created tool", async () => {
    const startupConfig = asOpenClawConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
      },
    });
    const patchedConfig = asOpenClawConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
      },
    });
    let liveConfig = startupConfig;
    const tool = createMemorySearchTool({
      config: startupConfig,
      getConfig: () => liveConfig,
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    liveConfig = patchedConfig;
    await tool.execute("patched-config", { query: "provider switch" });

    expect(getMemorySearchManagerMockConfigs()).toEqual([patchedConfig]);
  });
});

describe("memory_search corpus surfacing (#72885)", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("surfaces session-transcript hits with corpus=sessions, not corpus=memory", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "agents/main/sessions/abc-123.jsonl",
        startLine: 1,
        endLine: 4,
        score: 0.91,
        snippet: "transcript hit",
        source: "sessions" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_session_corpus", { query: "transcript" });
    const details = result.details as { results: Array<{ corpus: string; source: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.source).toBe("sessions");
    expect(details.results[0]?.corpus).toBe("sessions");
  });

  it("surfaces durable memory-file hits with corpus=memory", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 4,
        score: 0.95,
        snippet: "memory hit",
        source: "memory" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_memory_corpus", { query: "memory" });
    const details = result.details as { results: Array<{ corpus: string; source: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.source).toBe("memory");
    expect(details.results[0]?.corpus).toBe("memory");
  });

  it("preserves source/corpus alignment across mixed-source result sets", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "memory",
        source: "memory" as const,
      },
      {
        path: "agents/main/sessions/abc-123.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.92,
        snippet: "transcript",
        source: "sessions" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_mixed", { query: "anything" });
    const details = result.details as { results: Array<{ corpus: string; source: string }> };
    expect(details.results).toHaveLength(2);
    for (const hit of details.results) {
      expect(hit.corpus).toBe(hit.source);
    }
  });
});
