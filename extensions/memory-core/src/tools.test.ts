// Memory Core tests cover tools plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockConfigs,
  getMemorySearchManagerMockParams,
  getMemorySyncMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryCustomStatus,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
  setMemorySyncImpl,
} from "./memory-tool-manager.test-mocks.js";
import { createMemorySearchTool, testing as memoryToolsTesting } from "./tools.js";
import { MemoryGetSchema, MemorySearchSchema } from "./tools.shared.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:main": {
    sessionId: "thread-1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/thread-1.jsonl",
  },
}));

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: sessionStore,
    })),
  };
});

describe("memory tool schemas", () => {
  it("uses flat corpus enums for provider tool compatibility", () => {
    const searchCorpus = MemorySearchSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };
    const getCorpus = MemoryGetSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };

    expect(searchCorpus.anyOf).toBeUndefined();
    expect(searchCorpus.enum).toEqual(["memory", "wiki", "all", "sessions"]);
    expect(getCorpus.anyOf).toBeUndefined();
    expect(getCorpus.enum).toEqual(["memory", "wiki", "all"]);
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });

  it("rejects fractional maxResults before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("fractional-max-results", {
        query: "hello",
        maxResults: 1.5,
      }),
    ).rejects.toThrow("maxResults must be a positive integer");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects malformed minScore before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("malformed-min-score", {
        query: "hello",
        minScore: "0.8junk",
      }),
    ).rejects.toThrow("minScore must be a finite number");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("passes string minScore through to memory search", async () => {
    let seenMinScore: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenMinScore = opts?.minScore;
      return [];
    });
    const tool = createMemorySearchToolOrThrow();

    await tool.execute("string-min-score", {
      query: "hello",
      minScore: "0.8",
    });

    expect(seenMinScore).toBe(0.8);
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

  it("returns unavailable metadata when manager setup does not settle", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchManagerImpl(async () => await new Promise(() => {}));
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("manager-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search timed out before the index/embedding backend responded.",
        action:
          "Retry memory_search; if timeouts persist, check embedding-provider latency and index health (openclaw memory status --deep).",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unavailable metadata when memory search does not settle", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchCalls += 1;
        searchSignal = opts?.signal;
        return await new Promise(() => {});
      });
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("search-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search timed out before the index/embedding backend responded.",
        action:
          "Retry memory_search; if timeouts persist, check embedding-provider latency and index health (openclaw memory status --deep).",
      });
      // The deadline must abort the orphaned search, not just race past it.
      expect(searchSignal?.aborted).toBe(true);
      const cooldownResult = await tool.execute("search-cooldown", { query: "hello again" });
      expectUnavailableMemorySearchDetails(cooldownResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search timed out before the index/embedding backend responded.",
        action:
          "Retry memory_search; if timeouts persist, check embedding-provider latency and index health (openclaw memory status --deep).",
      });
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout result when an abort-aware search rejects on abort", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchImpl(
        async (opts) =>
          await new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(new Error("openai-compatible embeddings query failed: aborted")),
              { once: true },
            );
          }),
      );
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("abort-aware-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search timed out before the index/embedding backend responded.",
        action:
          "Retry memory_search; if timeouts persist, check embedding-provider latency and index health (openclaw memory status --deep).",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-resolves the manager once when a cached sqlite handle was closed", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        throw new Error("database is not open");
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("closed-db", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "Thread-hidden codename: ORBIT-22.",
        source: "memory",
      },
    ]);
    expect(searchCalls).toBe(2);
    expect(getMemorySearchManagerMockCalls()).toBe(2);
    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({ purpose: undefined }),
      expect.objectContaining({ purpose: undefined }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(0);
  });

  it("re-resolves and closes one-shot CLI managers when a cached sqlite handle was closed", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        throw new Error("database is not open");
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
      oneShotCliRun: true,
    });
    const result = await tool.execute("closed-db-cli", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "Thread-hidden codename: ORBIT-22.",
        source: "memory",
      },
    ]);
    expect(searchCalls).toBe(2);
    expect(getMemorySearchManagerMockCalls()).toBe(2);
    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({ purpose: "cli" }),
      expect.objectContaining({ purpose: "cli" }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("forces a sync and retries once when the first search has zero hits", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        return [];
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("zero-hit-retry", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results?.[0]?.path).toBe(
      "MEMORY.md",
    );
    expect(searchCalls).toBe(2);
  });

  it("abandons a zero-hit forced sync that outruns the deadline without latching a cooldown", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return [];
      });
      // Forced sync never settles: it must be abandoned at the budget, not
      // awaited until the hard tool timeout.
      setMemorySyncImpl(() => new Promise<void>(() => {}));
      const tool = createMemorySearchToolOrThrow({
        config: {
          agents: { list: [{ id: "main", default: true }] },
          memory: { citations: "off" },
        },
      });

      const resultPromise = tool.execute("slow-forced-sync", { query: "hidden thread codename" });
      // Advance past the forced-sync budget (timeout - safety margin) but the
      // call must already have resolved well before the 15s hard deadline.
      await vi.advanceTimersByTimeAsync(13_000);
      const result = await resultPromise;

      // Available, empty result — NOT an unavailable/timeout payload.
      const details = result.details as { results?: unknown[]; disabled?: boolean };
      expect(details.disabled).toBeUndefined();
      expect(details.results).toEqual([]);
      // Only the initial search ran; the post-sync retry was skipped because the
      // sync was abandoned.
      expect(searchCalls).toBe(1);
      expect(getMemorySyncMockCalls()).toBe(1);

      // A merely-slow sync must not trip the 60s provider-error cooldown: the
      // next call still queries memory rather than short-circuiting.
      setMemorySyncImpl(() => undefined);
      let secondCallSearches = 0;
      setMemorySearchImpl(async () => {
        secondCallSearches += 1;
        return [];
      });
      await tool.execute("after-slow-forced-sync", { query: "hidden thread codename" });
      expect(secondCallSearches).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the zero-hit forced sync for one-shot CLI runs so cleanup cannot hang", async () => {
    // Regression: bounding the forced-sync wait in the tool body is not enough
    // for one-shot CLI runs, because the `finally` tears the manager down and
    // close() awaits any in-flight sync UNBOUNDED — relocating the hang to
    // cleanup. The fix skips the optional forced sync entirely for purpose=cli,
    // so a slow/stuck sync is never even started on that path.
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      return [];
    });
    // If this sync were ever awaited (directly or via close()), the test would
    // hang forever rather than fail — which is exactly the bug under guard.
    setMemorySyncImpl(() => new Promise<void>(() => {}));

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
      oneShotCliRun: true,
    });
    const result = await tool.execute("one-shot-zero-hit", { query: "hidden thread codename" });

    // Available, empty result — NOT an unavailable/timeout payload.
    const details = result.details as { results?: unknown[]; disabled?: boolean };
    expect(details.disabled).toBeUndefined();
    expect(details.results).toEqual([]);
    // The optional forced sync was skipped (never started) and only the initial
    // search ran; the one-shot manager was still closed exactly once.
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("surfaces an honest timeout message instead of blaming the embedding provider", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchImpl(async () => await new Promise(() => {}));
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("honest-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;

      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search timed out before the index/embedding backend responded.",
        action:
          "Retry memory_search; if timeouts persist, check embedding-provider latency and index health (openclaw memory status --deep).",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unavailable metadata when the index identity is paused", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      return [];
    });
    const reason = "index was built for provider openai, expected ollama";
    setMemoryCustomStatus({
      indexIdentity: {
        status: "mismatched",
        reason,
      },
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("paused-index", { query: "hidden thread codename" });

    expectUnavailableMemorySearchDetails(result.details, {
      error: reason,
      warning:
        "Tell the user: memory search is paused because the memory index was built with a different embedding provider/model/settings.",
      action:
        "Tell the user to run: openclaw memory status --index or openclaw memory index --force.",
    });
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
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
    const details = result.details as {
      mode?: unknown;
      debug?: {
        backend?: unknown;
        configuredMode?: unknown;
        effectiveMode?: unknown;
        fallback?: unknown;
        hits?: unknown;
        searchMs?: number;
      };
    };
    expect(details.mode).toBe("query");
    expect(details.debug?.backend).toBe("qmd");
    expect(details.debug?.configuredMode).toBe("search");
    expect(details.debug?.effectiveMode).toBe("query");
    expect(details.debug?.fallback).toBe("unsupported-search-flags");
    expect(details.debug?.hits).toBe(1);
    expect(details.debug?.searchMs).toBeGreaterThanOrEqual(0);
  });
});

describe("memory_search corpus labels", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("uses explicit plugin context agent over synthetic active-memory session keys", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          list: [
            { id: "main", default: true, memorySearch: { enabled: false } },
            { id: "recall", memorySearch: { enabled: true } },
          ],
        },
      }),
      agentId: "recall",
      agentSessionKey: "explicit:user-session:active-memory:abc123",
    });

    await tool.execute("recall", { query: "favorite food" });

    expect(getMemorySearchManagerMockParams().at(-1)?.agentId).toBe("recall");
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

  it("preserves source corpus labels for memory and session transcript hits", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory" as const,
      },
      {
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("mixed", { query: "thread note" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory",
      },
      {
        corpus: "sessions",
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions",
      },
    ]);
  });
});
