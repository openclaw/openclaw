import "./tools.session-catalog.test-mocks.js";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryToolOptions } from "./memory-tool-contract.js";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockParams,
  getMemorySyncMockCalls,
  resetMemoryToolMockState,
  setMemoryCloseImpl,
  setMemoryCustomStatus,
  setMemoryLastSyncError,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
  setMemorySourceCounts,
  setMemoryStatusDirty,
} from "./memory-tool-manager.test-mocks.js";
import { testing as memoryToolsTesting } from "./tools.js";
import {
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

function hit(
  path: string,
  source: "memory" | "sessions",
  snippet: string,
  score = 0.9,
): MemorySearchResult {
  return { path, source, snippet, score, startLine: 1, endLine: 2 };
}

function searchHits(hits: MemorySearchResult[]) {
  const search = vi.fn<Parameters<typeof setMemorySearchImpl>[0]>(async () => hits);
  setMemorySearchImpl(search);
  return search;
}

function corpusTool(
  search: NonNullable<NonNullable<MemoryToolOptions["config"]>["memory"]>["search"] = {},
  options: Pick<MemoryToolOptions, "agentSessionKey" | "conversationRecall"> = {},
  visibility: "self" | "agent" | "all" = "self",
  dmScope?: "per-channel-peer",
) {
  return createMemorySearchToolOrThrow({
    config: {
      agents: { entries: { main: {} } },
      memory: { citations: "off", search },
      tools: { sessions: { visibility } },
      ...(dmScope ? { session: { dmScope } } : {}),
    },
    agentSessionKey: "agent:main:main",
    ...options,
  });
}

const recall = (corpus: "sessions" | "configured") => ({
  anchorSessionKey: "agent:main:main",
  scope: "same-agent-private" as const,
  corpus,
});

describe("memory tool schemas", () => {
  it.each([
    { query: "X", min_score: 0.3, max_results: 3 },
    { query: "X", minScore: 0.3, maxResults: 3 },
  ])("normalizes supported search argument spellings: %j", (args) => {
    const tool = createMemorySearchToolOrThrow();
    const prepared = tool.prepareArguments?.(args) ?? args;
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    expect(prepared).toEqual({ query: "X", minScore: 0.3, maxResults: 3 });
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState();
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });

  it("rejects an unknown corpus before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    // Unknown corpora must not expose recall-only transcripts.
    await expect(
      tool.execute("unknown-corpus", {
        query: "hello",
        corpus: "everything",
      }),
    ).rejects.toThrow("corpus must be one of: memory, wiki, all, sessions");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it.each([
    {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    },
    {
      error:
        "SQLite support is unavailable in this Node runtime (missing node:sqlite). No such built-in module: node:sqlite",
      warning:
        "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support.",
      action:
        "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search.",
    },
  ])("reports actionable unavailability for $error", async (expected) => {
    setMemorySearchManagerImpl(async () => ({ error: expected.error }));
    const result = await createMemorySearchToolOrThrow().execute("unavailable", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, expected);
  });

  it("treats a provider error worded like the deadline as a provider failure", async () => {
    // Provider text must not acquire the tool deadline's provenance.
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      throw new Error("memory_search timed out after 30s");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("provider-worded-like-deadline", { query: "hello" });
    expect(result.details).not.toHaveProperty("timedOut");
    expectUnavailableMemorySearchDetails(result.details, {
      error: "memory_search timed out after 30s",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
    // The cooldown replay must carry the same provenance, not re-derive it.
    const cooldownResult = await tool.execute("provider-worded-cooldown", { query: "hello again" });
    expect(cooldownResult.details).toEqual(result.details);
    expect(searchCalls).toBe(1);
  });

  it("returns unavailable metadata when memory search does not settle", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchCalls += 1;
        searchSignal = opts?.signal;
        return await new Promise((_resolve, reject) => {
          searchSignal?.addEventListener(
            "abort",
            () => reject(new Error("embedding query aborted")),
            {
              once: true,
            },
          );
        });
      });
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("search-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(searchSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const result = await resultPromise;
      expect(result.details).toMatchObject({ timedOut: true, timeoutMs: 30_000 });
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 30s",
        timeoutMs: 30_000,
        warning: "Memory search did not finish within its time limit.",
        action:
          "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent main, and rebuild with openclaw memory index --force --agent main only if it reports the index dirty or incomplete",
      });
      // The deadline must abort the orphaned search, not just race past it.
      expect(searchSignal?.aborted).toBe(true);
      const cooldownResult = await tool.execute("search-cooldown", { query: "hello again" });
      expect(cooldownResult.details).toEqual(result.details);
      expect(searchCalls).toBe(1);
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return [];
      });
      await vi.advanceTimersByTimeAsync(59_999);
      const pausedResult = await tool.execute("search-still-paused", { query: "hello again" });
      expect(pausedResult.details).toEqual(cooldownResult.details);
      expect(searchCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const retryResult = await tool.execute("search-retry", { query: "hello again" });
      expect(retryResult.details).toMatchObject({ results: [] });
      expect(retryResult.details).not.toHaveProperty("unavailable");
      expect(searchCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["search", "cleanup"] as const)(
    "propagates caller cancellation during %s without cooldown",
    async (phase) => {
      const controller = new AbortController();
      const abortError = new Error("agent run cancelled");
      let searchCalls = 0;
      let firstSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchCalls += 1;
        if (phase === "search" && searchCalls === 1) {
          firstSignal = opts?.signal;
          return await new Promise(() => {});
        }
        return [hit("MEMORY.md", "memory", "retry after cancellation")];
      });
      if (phase === "cleanup") {
        setMemoryCloseImpl(async () => await new Promise(() => {}));
      }
      const tool = createMemorySearchToolOrThrow({ oneShotCliRun: phase === "cleanup" });
      const cancelled = tool.execute("caller-abort", { query: "hello" }, controller.signal);
      await vi.waitFor(() => {
        if (phase === "search") {
          expect(firstSignal).toBeInstanceOf(AbortSignal);
        } else {
          expect(getMemoryCloseMockCalls()).toBe(1);
        }
      });
      expect(getMemorySearchManagerMockParams()[0]?.purpose === "cli").toBe(phase === "cleanup");
      controller.abort(abortError);
      await expect(cancelled).rejects.toBe(abortError);
      if (phase === "search") {
        expect(firstSignal?.aborted).toBe(true);
        expect(firstSignal?.reason).toBe(abortError);
      }
      setMemoryCloseImpl(async () => {});
      const retry = await tool.execute("caller-abort-retry", { query: "hello again" });
      expect(retry.details).toMatchObject({
        results: [expect.objectContaining({ path: "MEMORY.md" })],
      });
      expect(searchCalls).toBe(2);
    },
  );

  it("withholds paused-index hits without starting a tool-owned rebuild", async () => {
    const reason = "index was built for provider openai, expected ollama";
    setMemoryCustomStatus({
      indexIdentity: { status: "mismatched", reason, code: "provider", owner: "configuration" },
    });
    searchHits([hit("MEMORY.md", "memory", "stale result")]);
    const result = await createMemorySearchToolOrThrow().execute("paused-index", {
      query: "stale",
    });
    expect(result.details).toMatchObject({ results: [], unavailable: true, error: reason });
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("qualifies results after automatic indexing fails", async () => {
    setMemoryStatusDirty(true);
    setMemoryLastSyncError("embedding request timed out");
    setMemorySearchImpl(async () => []);
    const tool = createMemorySearchToolOrThrow({ config: { memory: { citations: "off" } } });

    const result = await tool.execute("failed-index", { query: "hidden codeword" });

    expect(result.details).toMatchObject({
      results: [],
      stale: true,
      warning:
        "Memory index is stale: embedding request timed out. Search results may be incomplete.",
      action:
        "Run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.",
    });
  });
});

describe("memory_search corpus labels", () => {
  beforeEach(() => resetMemoryToolMockState());

  it("backfills a visible bootstrap result when the published chunk count is zero", async () => {
    const hits = [
      hit("sessions/missing.jsonl", "sessions", "hidden"),
      hit("sessions/past-thread.jsonl", "sessions", "visible"),
    ];
    const search = vi.fn<Parameters<typeof setMemorySearchImpl>[0]>(async (options) =>
      hits.slice(0, options?.maxResults),
    );
    setMemorySearchImpl(search);
    setMemorySourceCounts([]);
    const tool = corpusTool(
      { sources: ["sessions"], rememberAcrossConversations: true },
      {},
      "all",
    );
    const result = await tool.execute("bootstrap", {
      query: "result",
      corpus: "sessions",
      maxResults: 1,
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 200 }));
    expect(result.details).toMatchObject({ results: [{ snippet: "visible" }] });
  });

  it("does not let corpus=all broaden implicitly indexed recall transcripts", async () => {
    const search = searchHits([
      hit("sessions/private-group.jsonl", "sessions", "private transcript", 0.95),
    ]);
    const tool = corpusTool({ rememberAcrossConversations: true }, {}, "all");

    const result = await tool.execute("ordinary-search", {
      query: "favorite food",
      corpus: "all",
    });
    const details = result.details as { results: Array<{ source: string }> };

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sources: ["memory"] }));
    expect(details.results).toEqual([]);
  });

  it("does not expose recall-only sessions to ordinary search", async () => {
    const tool = corpusTool({ rememberAcrossConversations: true }, {}, "all");

    const result = await tool.execute("sessions-unavailable", {
      query: "favorite food",
      corpus: "sessions",
    });

    expect(result.details).toMatchObject({
      error: "Session transcript search is not enabled.",
      warning: "Session transcript search is unavailable for this agent.",
      action: expect.stringContaining(
        "If an exact session-history capability is available for this run",
      ),
    });
    expect((result.details as { action?: string }).action).not.toContain("sessions_search");
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it.each([
    { visibility: "agent" as const, visible: true },
    { visibility: "self" as const, visible: false },
  ])(
    "keeps migrated isolated-DM reset recall within visibility=$visibility",
    async ({ visibility, visible }) => {
      const search = searchHits([
        hit(
          "sessions/main/past-thread.jsonl.reset.2026-08-23T07-10-59.000Z",
          "sessions",
          "Retained pre-reset conversation fact",
          0.9,
        ),
      ]);
      const tool = corpusTool(
        {
          rememberAcrossConversations: false,
          experimental: { sessionMemory: true },
          sources: ["memory", "sessions"],
        },
        {},
        visibility,
        "per-channel-peer",
      );

      const result = await tool.execute("isolated-session-search", {
        query: "pre-reset conversation",
        corpus: "sessions",
      });
      const details = result.details as { results: Array<{ corpus: string; snippet: string }> };

      expect(search).toHaveBeenCalledWith(expect.objectContaining({ sources: ["sessions"] }));
      expect(details.results).toEqual(
        visible
          ? [
              expect.objectContaining({
                corpus: "sessions",
                snippet: "Retained pre-reset conversation fact",
              }),
            ]
          : [],
      );
    },
  );

  it("forces trusted conversation recall onto its authorized transcript corpus", async () => {
    const search = searchHits([
      hit("MEMORY.md", "memory", "Shared memory note", 0.95),
      hit("sessions/past-thread.jsonl", "sessions", "Prior private conversation", 0.9),
    ]);
    const tool = corpusTool(
      {},
      {
        conversationRecall: recall("sessions"),
        agentSessionKey: "agent:main:main:active-memory:abcdef123456",
      },
    );

    const result = await tool.execute("trusted-recall", {
      query: "favorite food",
      corpus: "memory",
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sources: ["sessions"] }));
    expect(details.results).toEqual([
      expect.objectContaining({
        corpus: "sessions",
        path: "sessions/past-thread.jsonl",
      }),
    ]);
  });

  it("retains configured sources for advanced trusted recall", async () => {
    const search = searchHits([
      hit("MEMORY.md", "memory", "Shared memory note", 0.95),
      hit("sessions/past-thread.jsonl", "sessions", "Prior private conversation", 0.9),
    ]);
    const tool = corpusTool({}, { conversationRecall: recall("configured") });

    const result = await tool.execute("advanced-recall", {
      query: "favorite food",
      corpus: "memory",
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sources: ["memory"] }));
    expect(details.results).toEqual([
      expect.objectContaining({ corpus: "memory", path: "MEMORY.md" }),
    ]);
  });
});
