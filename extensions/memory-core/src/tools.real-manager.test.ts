import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type {
  MemoryCorpusSearchResult,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInMemoryTestBackgroundContext } from "./memory/background-context.test-support.js";
import * as generationLease from "./memory/manager-index-generation-lease.js";
import {
  createManagerIndexFixture,
  type ManagerIndexFixture,
} from "./memory/manager-index.test-support.js";
import { createMemoryGetTool, createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");
const { MemoryIndexManager } = await import("./memory/manager.js");

function searchTool(
  config: OpenClawConfig,
  options: Parameters<typeof createMemorySearchTool>[0] = {},
) {
  const tool = createMemorySearchTool({
    config,
    agentId: "main",
    runInBackgroundContext: runInMemoryTestBackgroundContext,
    ...options,
  });
  if (!tool) {
    throw new Error("memory_search tool missing");
  }
  return tool;
}

describe("memory_search real manager", () => {
  const fixture: ManagerIndexFixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  const { provider, createConfig } = fixture;
  const memoryPath = "memory/2026-01-12.md";
  const wikiHit: MemoryCorpusSearchResult = {
    corpus: "wiki",
    path: "entities/alpha.md",
    score: 1,
    snippet: "Alpha wiki entry",
  };
  const alphaQuery = Object.freeze({ query: "alpha", corpus: "memory" });
  const zebraQuery = { query: "zebra", corpus: "memory" };

  function keywordConfig(sources: Array<"memory" | "sessions"> = ["memory"]) {
    return createConfig({
      provider: "none",
      sources,
      sessionMemory: sources.includes("sessions"),
      vectorEnabled: false,
    });
  }

  async function indexedManager(cfg: OpenClawConfig, purpose?: "cli", reason = purpose ?? "test") {
    const manager = await fixture.getFreshManager(cfg, purpose);
    await manager.sync({ reason, force: true });
    return manager;
  }

  function session(
    sessionId: string,
    content: string,
    role: "user" | "assistant" = "user",
    sessionKey = `agent:main:telegram:direct:${sessionId}`,
  ) {
    return fixture.seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [{ role, content, timestamp: "2026-08-30T09:00:00.000Z" }],
    });
  }

  function requireFormatRepair() {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      "UPDATE memory_index_meta SET value = json_set(value, '$.provenanceVersion', 0) WHERE key = 'memory_index_meta_v1'",
    ).run();
    return db;
  }

  function withWiki() {
    registerMemoryCorpusSupplement("wiki-fixture", {
      search: async () => [wikiHit],
      get: async () => null,
    });
  }

  beforeEach(() => testing.resetMemorySearchToolCooldowns());
  afterEach(() => {
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "non-first system agent", systemAgent: true, pinned: false },
    { name: "pinned workspaces", systemAgent: false, pinned: true },
  ])(
    "reads the indexed agent file with explicit ownership: $name",
    async ({ systemAgent, pinned }) => {
      const cfg = keywordConfig();
      const workspaces = {
        main: path.join(fixture.paths.workspace, pinned ? "pinned-main" : "main"),
        other: path.join(fixture.paths.workspace, pinned ? "pinned-other" : "other"),
      };
      const main = pinned ? { workspace: workspaces.main } : {};
      const other = pinned ? { workspace: workspaces.other } : {};
      cfg.agents = {
        ownership: "explicit",
        defaults: {
          workspace: fixture.paths.workspace,
          ...(systemAgent ? { systemAgent: { agentId: "other" } } : {}),
        },
        entries: { main, other },
      };
      cfg.memory = { ...cfg.memory, citations: "off" };
      await fs.writeFile(path.join(fixture.paths.workspace, "USER.md"), "Parent decoy\n");
      for (const [agentId, workspace] of Object.entries(workspaces)) {
        const marker = `Orchid workspace ${agentId}`;
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(path.join(workspace, "USER.md"), marker);
        const manager = fixture.requireManager(
          await getMemorySearchManager({
            runInBackgroundContext: runInMemoryTestBackgroundContext,
            cfg,
            agentId,
            purpose: "cli",
          }),
        );
        fixture.trackManager(manager);
        await manager.sync({ reason: "cli", force: true });
        await manager.close();

        const options = { config: cfg, agentId, oneShotCliRun: true };
        const search = searchTool(cfg, options);
        const get = createMemoryGetTool(options)!;
        const found = await search.execute("workspace-search", { query: marker, corpus: "memory" });
        const { results } = found.details as {
          results: Array<{ path: string; startLine: number; endLine: number; snippet: string }>;
        };
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          path: "USER.md",
          startLine: 1,
          endLine: 1,
          snippet: marker,
        });
        const hit = results[0]!;
        const excerpt = await get.execute("workspace-get", {
          path: hit.path,
          from: hit.startLine,
          lines: hit.endLine - hit.startLine + 1,
        });
        expect(excerpt.details).toMatchObject({ status: "ok", text: marker });
        const escaped = await get.execute("workspace-parent", { path: "../USER.md" });
        expect(escaped.details).toMatchObject({ status: "error", code: "MEMORY_PATH_NOT_ALLOWED" });
      }
    },
  );

  it("preserves indexed snippet indentation with citations", async () => {
    const text = "    CitationIndentSpaces()\n    preserveIndentation()";
    const filePath = path.join(fixture.paths.memory, "citation-indent.md");
    await fs.writeFile(filePath, text);
    const cfg = keywordConfig();
    cfg.memory = { ...cfg.memory, citations: "on" };
    cfg.plugins = {
      ...cfg.plugins,
      entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
    };
    const manager = await indexedManager(cfg, "cli");
    await manager.close();

    const tool = searchTool(cfg, {
      agentSessionKey: "agent:main:main",
      oneShotCliRun: true,
    });
    const result = await tool.execute("citation-indentation", {
      query: "CitationIndentSpaces",
      corpus: "memory",
    });
    const expected = {
      results: [
        {
          path: "memory/citation-indent.md",
          snippet: `${text}\n\nSource: memory/citation-indent.md#L1-L2`,
        },
      ],
    };
    expect(result.details).toMatchObject({
      results: [{ citation: "memory/citation-indent.md#L1-L2" }],
    });
    const content = result.content[0];
    if (!content || content.type !== "text") {
      throw new Error("memory_search returned no model-visible JSON");
    }
    expect
      .soft(JSON.parse(content.text), "model-visible JSON preserves snippet layout")
      .toMatchObject(expected);
    expect(await fs.readFile(filePath, "utf8")).toBe(text);
    expect(provider.embedBatchCalls).toBe(0);
    expect(provider.embedQueryCalls).toBe(0);
  });

  it("rejects a real session search hit as an unsupported file without disabling memory", async () => {
    const cfg = keywordConfig(["memory", "sessions"]);
    const sessionKey = "agent:main:telegram:direct:excerpt-proof";
    await session("excerpt-proof", "The excerpt marker is cobalt orchid.");
    await indexedManager(cfg);
    const options = { config: cfg, agentId: "main", agentSessionKey: sessionKey };
    const search = searchTool(cfg, options);
    const get = createMemoryGetTool(options)!;
    const found = await search.execute("session-search", {
      query: "cobalt orchid",
      corpus: "sessions",
    });
    const { results } = found.details as {
      results: Array<{ path: string; startLine: number; source: string }>;
    };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "sessions",
      path: "sessions/main/excerpt-proof.jsonl",
    });
    const excerpt = await get.execute("session-excerpt", {
      path: results[0]!.path,
      from: results[0]!.startLine,
      lines: 3,
    });
    expect(excerpt.details).toMatchObject({
      status: "error",
      code: "MEMORY_PATH_NOT_ALLOWED",
      text: "",
    });
    expect(excerpt.details).not.toHaveProperty("disabled");
    const memory = await get.execute("memory-excerpt", {
      path: memoryPath,
      from: 2,
      lines: 1,
    });
    expect(memory.details).toMatchObject({
      status: "ok",
      text: expect.stringContaining("Alpha memory line."),
      from: 2,
      lines: 1,
    });
  });

  it("recovers when the memory manager closes after repair without another rebuild", async () => {
    const cfg = createConfig({ vectorEnabled: false, minScore: 0 });
    cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, cache: { enabled: false } } };
    const manager = await indexedManager(cfg, undefined, "cli");
    const embeddingCalls = provider.embedBatchCalls;
    requireFormatRepair();
    const search = manager.search.bind(manager);
    vi.spyOn(manager, "search").mockImplementationOnce(async (...args) => {
      const results = await search(...args);
      await manager.close();
      return results;
    });
    const tool = searchTool(cfg);
    const result = await tool.execute("closed-memory-manager", alphaQuery);
    expect(result.details).not.toHaveProperty("error");
    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ path: memoryPath })],
    });
    expect(result.details).not.toHaveProperty("unavailable");
    expect(provider.embedBatchCalls).toBe(embeddingCalls + 1);
    expect(result.details).toHaveProperty("warning", expect.stringContaining("provider cost"));
  });

  it("preserves reindex guidance alongside wiki results after an embedding model change", async () => {
    const manager = await indexedManager(
      createConfig({ model: "old-embed", vectorEnabled: false }),
      undefined,
      "cli",
    );
    await manager.close();
    const embeddingCalls = provider.embedBatchCalls;
    withWiki();
    const tool = searchTool(createConfig({ model: "new-embed", vectorEnabled: false }));
    const action =
      "Tell the user to run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.";
    const primary = await tool.execute("paused-primary", { query: "alpha" });
    expect(primary.details).toMatchObject({
      disabled: true,
      unavailable: true,
      error: "index was built for model old-embed, expected new-embed",
      action,
    });

    const combined = await tool.execute("paused-with-wiki", { query: "alpha", corpus: "all" });
    expect(combined.details).toMatchObject({
      results: [wikiHit],
      corpora: [
        { corpus: "memory", outcome: "unavailable" },
        { corpus: "wiki", outcome: "ok" },
      ],
      warning: expect.stringContaining("Memory corpus unavailable"),
      action,
    });
    expect(combined.details).not.toHaveProperty("disabled");
    expect(combined.details).not.toHaveProperty("unavailable");
    expect(provider.embedBatchCalls).toBe(embeddingCalls);
    expect(provider.embedQueryCalls).toBe(0);
  });

  it("keeps routine transcript refresh silent during memory_search", async () => {
    const cfg = keywordConfig(["memory", "sessions"]);
    await session("refresh-proof", "The transcript refresh marker is cobalt orchid.");
    const manager = await indexedManager(cfg, undefined, "baseline");
    await session(
      "refresh-proof",
      "A second transcript write is waiting for indexing.",
      "assistant",
    );
    Reflect.set(manager, "sessionsDirty", true);

    const maintenanceReady = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        syncArchiveFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
      };
      const syncArchiveFiles = fields.syncArchiveFiles.bind(acquired);
      vi.spyOn(fields, "syncArchiveFiles").mockImplementation(async (syncParams) => {
        const result = await syncArchiveFiles(syncParams);
        maintenanceReady.resolve();
        await releaseMaintenance.promise;
        return result;
      });
      return acquired;
    });

    try {
      const tool = searchTool(cfg, {
        agentSessionKey: "agent:main:telegram:direct:active-refresh-proof",
      });
      const execution = tool.execute("routine-refresh", zebraQuery);
      await maintenanceReady.promise;
      const result = await execution;

      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ snippet: expect.stringContaining("Zebra") })],
      });
      expect(result.details).not.toHaveProperty("stale");
      expect(result.details).not.toHaveProperty("warning");
      expect(result.details).not.toHaveProperty("action");
    } finally {
      releaseMaintenance.resolve();
      getSpy.mockRestore();
    }
  });

  it("backfills visible sessions with one bounded query embedding", async () => {
    const cfg = createConfig({ sources: ["sessions"], sessionMemory: true, vectorEnabled: false });
    cfg.memory = { ...cfg.memory, citations: "off" };
    cfg.tools = { ...cfg.tools, sessions: { visibility: "self" } };
    const anchorSessionKey = "agent:main:telegram:direct:owner";

    await fixture.seedSessionTranscript({
      sessionId: "current",
      sessionKey: anchorSessionKey,
      messages: [],
    });
    for (const [sessionId, sessionKey, content] of [
      ["hidden-a", "agent:main:discord:group:hidden-a", "alpha alpha alpha hidden group a"],
      ["hidden-b", "agent:main:discord:group:hidden-b", "alpha alpha alpha hidden group b"],
      ["visible-a", "agent:main:telegram:direct:visible-a", "alpha beta visible private a"],
      ["visible-b", "agent:main:telegram:direct:visible-b", "alpha beta visible private b"],
    ] as const) {
      await session(sessionId, content, "assistant", sessionKey);
    }

    await indexedManager(cfg);

    const tool = searchTool(cfg, {
      agentSessionKey: `${anchorSessionKey}:active-memory:abcdef123456`,
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    const result = await tool.execute("real-manager-visible-backfill", {
      query: "alpha",
      corpus: "sessions",
      maxResults: 2,
    });
    expect(result.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ snippet: expect.stringContaining("visible private a") }),
        expect.objectContaining({ snippet: expect.stringContaining("visible private b") }),
      ]),
      debug: { hits: 2, candidateHits: 4, withheldHits: 2, searchWindow: 4 },
    });
    expect(result.details).toHaveProperty("results.length", 2);
    expect(provider.embedQueryCalls).toBe(1);
    expect(provider.embeddedQueryTexts).toEqual(["alpha"]);
  });

  it("returns memory-file keyword matches at the deadline without cooling down healthy recall", async () => {
    const cfg = createConfig({ minScore: 0, vectorEnabled: false });
    await indexedManager(cfg, undefined, "baseline");
    const queryEntered = createDeferred<void>();
    const releaseQuery = createDeferred<void>();
    provider.beforeEmbedQuery = async () => {
      queryEntered.resolve();
      await releaseQuery.promise;
    };
    const tool = searchTool(cfg);
    vi.useFakeTimers();
    const execution = tool.execute("keyword-deadline", zebraQuery);
    try {
      await queryEntered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await execution;
      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ path: memoryPath, source: "memory" })],
        partial: true,
        timedOut: true,
        timeoutMs: 30_000,
        mode: "keyword-only",
        warning: expect.stringContaining("Only memory-file keyword matches"),
        error: "memory_search timed out after 30s",
        corpora: [{ corpus: "memory", outcome: "partial" }],
        debug: { searchMs: 30_000 },
      });
      expect(result.details).not.toHaveProperty("unavailable");
    } finally {
      releaseQuery.resolve();
      provider.beforeEmbedQuery = null;
      vi.useRealTimers();
    }
    const retried = await tool.execute("partial-results-retry", zebraQuery);
    expect(retried.details).not.toHaveProperty("unavailable");
    expect(provider.embedQueryCalls).toBe(2);
  });

  it("survives a managed local-service cold start longer than the search deadline", async () => {
    const cfg = createConfig({ minScore: 0 });
    await indexedManager(cfg, undefined, "baseline");
    const acquisitionStarted = createDeferred<void>();
    const acquisitionReady = createDeferred<void>();
    provider.beforeEmbedQuery = async (options) => {
      const control = options?.[MEMORY_SEARCH_DEADLINE_CONTROL];
      control?.report("pause");
      try {
        acquisitionStarted.resolve();
        await acquisitionReady.promise;
      } finally {
        control?.report("resume");
      }
    };
    const tool = searchTool(cfg);
    vi.useFakeTimers();
    const execution = tool.execute("cold-start-readiness", zebraQuery);
    try {
      await acquisitionStarted.promise;
      await vi.advanceTimersByTimeAsync(70_000);
      acquisitionReady.resolve();
      const result = await execution;
      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ path: memoryPath, source: "memory" })],
      });
      expect(result.details).not.toHaveProperty("error");
      expect(result.details).not.toHaveProperty("partial");
    } finally {
      acquisitionReady.resolve();
      provider.beforeEmbedQuery = null;
      vi.useRealTimers();
    }
    const retried = await tool.execute("cold-start-retry", zebraQuery);
    expect(retried.details).not.toHaveProperty("unavailable");
    expect(provider.embedQueryCalls).toBe(2);
  });

  it("preserves canonical-session migration recovery through cooldown", async () => {
    const cfg = keywordConfig(["sessions"]);
    cfg.memory = { ...cfg.memory, citations: "off" };
    await session("recovery-source", "Operator recovery instructions.");
    const initializedManager = await indexedManager(cfg);
    await initializedManager.close();
    await closeAllMemorySearchManagers();

    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "Agent:Main:Main",
        "legacy-session",
        JSON.stringify({ sessionId: "legacy-session", updatedAt: 1 }),
        1,
      );
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    const tool = searchTool(cfg, { agentSessionKey: "agent:main:main" });

    const first = await tool.execute("migration-first", { query: "operator recovery" });
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run("Agent:Main:Main");
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const replay = await tool.execute("migration-replay", {
      query: "different anti-cheat query",
    });
    const expected = {
      unavailable: true,
      error: expect.stringContaining("openclaw doctor --fix"),
      warning:
        "Memory search is unavailable because the session catalog requires canonical-key migration.",
      action:
        "Stop the Gateway and run openclaw doctor --fix, then restart the Gateway and retry memory_search.",
    };

    expect(first.details).toMatchObject(expected);
    expect(replay.details).toMatchObject(expected);
    expect(provider.embedQueryCalls).toBe(0);
  });

  it("returns a timed-out one-shot search before pending cleanup finishes", async () => {
    const cfg = keywordConfig();
    const initializedManager = await indexedManager(cfg, "cli", "test");
    const databasePath = initializedManager.status().dbPath;
    if (!databasePath) {
      throw new Error("memory search manager database path missing");
    }
    await initializedManager.close();

    const publicationEntered = createDeferred<void>();
    const releasePublication = createDeferred<void>();
    const publication = generationLease.withMemoryIndexGeneration(
      databasePath,
      "write",
      async () => {
        publicationEntered.resolve();
        await releasePublication.promise;
      },
    );
    await publicationEntered.promise;

    const tool = searchTool(cfg, { oneShotCliRun: true });
    const searchStarted = createDeferred<void>();
    const cleanupStarted = createDeferred<void>();
    const releaseCleanup = createDeferred<void>();
    const cleanupFinished = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "cli" || !acquired) {
        return acquired;
      }
      const search = acquired.search.bind(acquired);
      vi.spyOn(acquired, "search").mockImplementation(async (...args) => {
        searchStarted.resolve();
        return await search(...args);
      });
      const close = acquired.close.bind(acquired);
      vi.spyOn(acquired, "close").mockImplementation(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        await close();
        cleanupFinished.resolve();
      });
      return acquired;
    });
    vi.useFakeTimers();
    let executionSettled = false;
    const execution = tool.execute("timed-out-generation-wait", { query: "zebra" }).finally(() => {
      executionSettled = true;
    });
    try {
      await searchStarted.promise;
      await vi.advanceTimersByTimeAsync(30_100);
      expect(executionSettled).toBe(true);
      await cleanupStarted.promise;
      await expect(execution).resolves.toMatchObject({
        details: { unavailable: true },
      });
    } finally {
      releasePublication.resolve();
      releaseCleanup.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await publication;
      await execution.catch(() => undefined);
      await cleanupFinished.promise;
      getSpy.mockRestore();
    }
  });
});
