import { beforeEach, describe, expect, it } from "vitest";
import {
  getMemorySearchManagerMockAgentIds,
  getMemorySearchManagerMockConfigs,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemorySearchImpl,
  setMemorySearchImplForAgent,
} from "./memory-tool-manager-mock.js";
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

  it("adds provenance fields while preserving existing result fields", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-28/2026-04-28.md",
        startLine: 3,
        endLine: 7,
        score: 0.88,
        snippet: "vector memory",
        source: "memory",
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: { list: [{ id: "backend", default: true }] },
      }),
      agentSessionKey: "agent:backend:main:memory:provenance",
    });
    const result = await tool.execute("provenance", { query: "vector memory" });

    expect(result.details).toMatchObject({
      results: [
        {
          path: "memory/2026-04-28/2026-04-28.md",
          startLine: 3,
          endLine: 7,
          agent_id: "backend",
          source_path: "memory/2026-04-28/2026-04-28.md",
          start_line: 3,
          end_line: 7,
          corpus: "memory",
        },
      ],
    });
  });

  it("scopes normal agents to their own memory", async () => {
    setMemorySearchImplForAgent("backend", async () => [
      {
        path: "backend/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "backend only",
        source: "memory",
      },
    ]);
    setMemorySearchImplForAgent("chief", async () => [
      {
        path: "chief/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.99,
        snippet: "chief secret",
        source: "memory",
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: { list: [{ id: "backend", default: true }, { id: "chief" }] },
      }),
      agentSessionKey: "agent:backend:main:memory:scope",
    });
    const result = await tool.execute("scope", {
      query: "secret",
      agent_id: "chief",
      maxResults: 10,
    });

    expect(getMemorySearchManagerMockAgentIds()).toEqual(["backend"]);
    expect(result.details).toMatchObject({
      results: [
        {
          path: "backend/MEMORY.md",
          agent_id: "backend",
        },
      ],
    });
  });

  it("allows chief to search across configured agents by default", async () => {
    setMemorySearchImplForAgent("backend", async () => [
      {
        path: "backend/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.6,
        snippet: "backend note",
        source: "memory",
      },
    ]);
    setMemorySearchImplForAgent("chief", async () => [
      {
        path: "chief/MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "chief note",
        source: "memory",
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: { list: [{ id: "chief", default: true }, { id: "backend" }] },
      }),
      agentSessionKey: "agent:chief:main:memory:scope",
    });
    const result = await tool.execute("chief-scope", { query: "note", maxResults: 10 });

    expect(getMemorySearchManagerMockAgentIds()).toEqual(["chief", "backend"]);
    expect(result.details).toMatchObject({
      results: [
        { path: "chief/MEMORY.md", agent_id: "chief" },
        { path: "backend/MEMORY.md", agent_id: "backend" },
      ],
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
