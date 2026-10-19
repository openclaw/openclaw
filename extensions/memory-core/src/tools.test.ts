import "./tools.session-catalog.test-mocks.js";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function mockSearch(impl: Parameters<typeof setMemorySearchImpl>[0]) {
  const search = vi.fn(impl);
  setMemorySearchImpl(search);
  return search;
}

const searchHits = (hits: MemorySearchResult[]) => mockSearch(async () => hits);

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

function executeSearch(
  tool = createMemorySearchToolOrThrow(),
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return tool.execute("search", { query: "hello", ...params }, signal);
}

describe("memory tool schemas", () => {
  it.each([
    [{ min_score: 0.3, max_results: 3 }, true],
    [{ minScore: 0.3, maxResults: 3 }, true],
    [{ minScore: 0.3, limit: 3 }, true],
    [{ maxResults: 3, limit: 10 }, false],
    [{ max_results: 3, limit: 10 }, false],
    [{ limit: 10, max_results: 5, maxResults: 3 }, false],
  ] as const)("normalizes aliases and prioritizes explicit caps: %j", (args, scored) => {
    const tool = createMemorySearchToolOrThrow();
    const input = { query: "X", ...args };
    const prepared = tool.prepareArguments?.(input) ?? input;
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    expect(prepared).toEqual({ query: "X", maxResults: 3, ...(scored ? { minScore: 0.3 } : {}) });
  });

  it.each([0, -1, 1.5, "3", null])("rejects invalid result caps: %j", (value) => {
    const tool = createMemorySearchToolOrThrow();
    for (const caps of [
      { limit: value },
      { maxResults: value },
      { maxResults: value, max_results: 3, limit: 10 },
      { max_results: value, limit: 10 },
    ]) {
      const prepared = tool.prepareArguments?.({ query: "X", ...caps });
      expect(prepared).toEqual({ query: "X", maxResults: value });
      expect(Value.Check(tool.parameters, prepared)).toBe(false);
    }
  });

  it("describes search as evidence-driven without repeating supplied recall", () => {
    const description = createMemorySearchToolOrThrow().description;

    expect(description).toContain("not already present in the current turn");
    expect(description).toContain("Do not repeat memory retrieval");
    expect(description).not.toContain("Mandatory recall step");
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState();
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });
  afterEach(() => vi.useRealTimers());

  it("rejects an unknown corpus before searching", async () => {
    await expect(executeSearch(undefined, { corpus: "everything" })).rejects.toThrow(
      "corpus must be one of: memory, wiki, all, sessions",
    );
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
    const result = await executeSearch();
    expectUnavailableMemorySearchDetails(result.details, expected);
  });

  it("treats a provider error worded like the deadline as a provider failure", async () => {
    const searchImpl = mockSearch(async () => {
      throw new Error("memory_search timed out after 30s");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await executeSearch(tool);
    expect(result.details).not.toHaveProperty("timedOut");
    expectUnavailableMemorySearchDetails(result.details, {
      error: "memory_search timed out after 30s",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
    const cooldownResult = await executeSearch(tool, { query: "hello again" });
    expect(cooldownResult.details).toEqual(result.details);
    expect(searchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable metadata when memory search does not settle", async () => {
    vi.useFakeTimers();
    let searchSignal: AbortSignal | undefined;
    const searchImpl = mockSearch(async (opts) => {
      searchSignal = opts?.signal;
      return await new Promise((_resolve, reject) => {
        searchSignal?.addEventListener(
          "abort",
          () => reject(new Error("embedding query aborted")),
          { once: true },
        );
      });
    });
    const tool = createMemorySearchToolOrThrow();

    const resultPromise = executeSearch(tool);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(searchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await resultPromise;
    expectUnavailableMemorySearchDetails(result.details, {
      error: "memory_search timed out after 30s",
      timeoutMs: 30_000,
      warning: "Memory search did not finish within its time limit.",
      action:
        "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent main, and rebuild with openclaw memory index --force --agent main only if it reports the index dirty or incomplete",
    });
    expect(searchSignal?.aborted).toBe(true);
    const cooldownResult = await executeSearch(tool, { query: "hello again" });
    expect(cooldownResult.details).toEqual(result.details);
    expect(searchImpl).toHaveBeenCalledTimes(1);
    searchImpl.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(59_999);
    const pausedResult = await executeSearch(tool, { query: "hello again" });
    expect(pausedResult.details).toEqual(cooldownResult.details);
    expect(searchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const retryResult = await executeSearch(tool, { query: "hello again" });
    expect(retryResult.details).toMatchObject({ results: [] });
    expect(retryResult.details).not.toHaveProperty("unavailable");
    expect(searchImpl).toHaveBeenCalledTimes(2);
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
      const cancelled = executeSearch(tool, {}, controller.signal);
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
      const retry = await executeSearch(tool, { query: "hello again" });
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
    const result = await executeSearch();
    expect(result.details).toMatchObject({ results: [], unavailable: true, error: reason });
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("qualifies results after automatic indexing fails", async () => {
    setMemoryStatusDirty(true);
    setMemoryLastSyncError("embedding request timed out");
    setMemorySearchImpl(async () => []);
    const result = await executeSearch(
      createMemorySearchToolOrThrow({ config: { memory: { citations: "off" } } }),
    );
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
    const searchImpl = mockSearch(async (options) => hits.slice(0, options?.maxResults));
    setMemorySourceCounts([]);
    const tool = corpusTool(
      { sources: ["sessions"], rememberAcrossConversations: true },
      {},
      "all",
    );
    const result = await executeSearch(tool, { corpus: "sessions", maxResults: 1 });
    expect(searchImpl).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 200 }));
    expect(result.details).toMatchObject({ results: [{ snippet: "visible" }] });
  });

  it("does not let corpus=all broaden implicitly indexed recall transcripts", async () => {
    const searchImpl = searchHits([
      hit("sessions/private-group.jsonl", "sessions", "private transcript", 0.95),
    ]);
    const tool = corpusTool({ rememberAcrossConversations: true }, {}, "all");

    const result = await executeSearch(tool, { corpus: "all" });
    expect(searchImpl).toHaveBeenCalledWith(expect.objectContaining({ sources: ["memory"] }));
    expect(result.details).toHaveProperty("results", []);
  });

  it("does not expose recall-only sessions to ordinary search", async () => {
    const tool = corpusTool({ rememberAcrossConversations: true }, {}, "all");

    const result = await executeSearch(tool, { corpus: "sessions" });
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
      const searchImpl = searchHits([
        hit(
          "sessions/main/past-thread.jsonl.reset.2026-08-23T07-10-59.000Z",
          "sessions",
          "pre-reset fact",
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

      const result = await executeSearch(tool, { corpus: "sessions" });
      expect(searchImpl).toHaveBeenCalledWith(expect.objectContaining({ sources: ["sessions"] }));
      expect(result.details).toHaveProperty(
        "results",
        visible ? [expect.objectContaining({ corpus: "sessions", snippet: "pre-reset fact" })] : [],
      );
    },
  );

  it.each([
    { corpus: "sessions" as const, path: "sessions/past-thread.jsonl" },
    { corpus: "configured" as const, path: "MEMORY.md" },
  ])("restricts trusted $corpus recall to its authorized source", async ({ corpus, path }) => {
    const searchImpl = searchHits([
      hit("MEMORY.md", "memory", "Shared memory note", 0.95),
      hit("sessions/past-thread.jsonl", "sessions", "Prior private conversation", 0.9),
    ]);
    const tool = corpusTool(
      {},
      {
        conversationRecall: recall(corpus),
        ...(corpus === "sessions"
          ? { agentSessionKey: "agent:main:main:active-memory:abcdef123456" }
          : {}),
      },
    );
    const result = await executeSearch(tool, { corpus: "memory" });
    const source = corpus === "configured" ? "memory" : corpus;
    expect(searchImpl).toHaveBeenCalledWith(expect.objectContaining({ sources: [source] }));
    expect(result.details).toHaveProperty("results", [
      expect.objectContaining({ corpus: source, path }),
    ]);
  });
});
