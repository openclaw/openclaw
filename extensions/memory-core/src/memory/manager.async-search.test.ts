// Memory Core tests cover manager.async search plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";
import { MemoryIndexManager } from "./manager.js";

describe("memory search async sync", () => {
  it("waits for dirty sync before querying", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncMock = vi.fn(async () => {
      return pendingSync;
    });
    const queryMock = vi.fn(async () => []);
    const manager = Object.create(MemoryIndexManager.prototype) as MemoryIndexManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      providerRequirement: { mode: "fts-only", provider: "none" },
      hasIndexedContent: () => true,
      settings: {
        sync: { onSearch: true },
        query: {
          minScore: 0,
          maxResults: 5,
          hybrid: {
            enabled: true,
            candidateMultiplier: 2,
            temporalDecay: { enabled: false, halfLifeDays: 30 },
          },
        },
      },
      warmSession: vi.fn(),
      ensureProviderInitialized: vi.fn(async () => {}),
      assertRequiredProviderAvailable: vi.fn(),
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      provider: null,
      providerLifecycle: { mode: "fts-only", reason: "test" },
      refreshIndexIdentityDirty: () => ({ status: "valid" }),
      sources: new Set(["memory"]),
      fts: { enabled: true, available: true },
      searchKeywordWithFallback: queryMock,
      workspaceDir: "",
    });

    const searchPromise = manager.search("current memory");
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledWith({ reason: "search" }));
    expect(queryMock).not.toHaveBeenCalled();

    expect(syncMock).toHaveBeenCalledTimes(1);
    releaseSync();
    await searchPromise;
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps vector-only results unweighted when FTS is unavailable", async () => {
    const vectorResult = {
      id: "memory-alpha",
      path: "memory/alpha.md",
      startLine: 1,
      endLine: 1,
      score: 0.9,
      snippet: "Alpha memory",
      source: "memory" as const,
    };
    const mergeHybridResults = vi.fn(async () => []);
    const manager = Object.create(MemoryIndexManager.prototype) as MemoryIndexManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
      providerRequirement: { mode: "optional", provider: "openai" },
      providerLifecycle: { mode: "ready" },
      provider: { id: "mock", model: "mock-embed" },
      settings: {
        sync: { onSearch: false },
        query: {
          minScore: 0.8,
          maxResults: 5,
          hybrid: {
            enabled: true,
            candidateMultiplier: 2,
            vectorWeight: 0.5,
            textWeight: 0.5,
            temporalDecay: { enabled: false, halfLifeDays: 30 },
          },
        },
      },
      sources: new Set(["memory"]),
      dirty: false,
      sessionsDirty: false,
      workspaceDir: "",
      drainReindex: vi.fn(async () => {}),
      hasIndexedContentForSearch: vi.fn(async () => true),
      warmSession: vi.fn(),
      sync: vi.fn(async () => {}),
      ensureProviderInitialized: vi.fn(async () => {}),
      assertRequiredProviderAvailable: vi.fn(),
      refreshSearchIndexIdentityDirty: vi.fn(async () => ({ status: "valid" })),
      searchKeywordWithFallback: vi.fn(async () => []),
      embedQueryWithRetry: vi.fn(async () => [1, 0]),
      searchVector: vi.fn(async () => [vectorResult]),
      hasKeywordSearchAvailable: vi.fn(async () => false),
      mergeHybridResults,
    });

    const results = await manager.search("alpha");

    expect(results).toEqual([vectorResult]);
    expect(mergeHybridResults).not.toHaveBeenCalled();
  });

  it("waits for in-flight search sync during close", async () => {
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });

    let closed = false;
    const closePromise = awaitPendingManagerWork({ pendingSync }).then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
  });

  it("skips background search sync when search-triggered sync is disabled", async () => {
    const syncMock = vi.fn(async () => {});
    await startAsyncSearchSync({
      enabled: false,
      dirty: true,
      sessionsDirty: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
