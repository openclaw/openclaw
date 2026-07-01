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

  it("self-heals a format-stale sessions-only index on search even when not file-dirty", async () => {
    // Regression: a clean sessions-only legacy index (dirty/sessionsDirty false)
    // with a stale FTS text-format is identity-dirty. search() must still trigger
    // sync so the format self-heal runs, instead of returning stale/empty results.
    const syncMock = vi.fn(async () => {});
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
      dirty: false,
      sessionsDirty: false,
      ftsTextFormatSelfHealPending: true,
      sync: syncMock,
      provider: null,
      providerLifecycle: { mode: "fts-only", reason: "test" },
      refreshIndexIdentityDirty: () => ({ status: "valid" }),
      sources: new Set(["sessions"]),
      fts: { enabled: true, available: true },
      searchKeywordWithFallback: queryMock,
      workspaceDir: "",
    });

    await manager.search("2026-06-17-1701");

    expect(syncMock).toHaveBeenCalledWith({ reason: "search" });
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
      ftsTextFormatSelfHealPending: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("triggers search sync when an FTS format self-heal is pending", async () => {
    // A clean sessions-only legacy index (memory/session flags false) whose FTS
    // text-format is stale must still self-heal via search-triggered sync.
    const syncMock = vi.fn(async () => {});
    await startAsyncSearchSync({
      enabled: true,
      dirty: false,
      sessionsDirty: false,
      ftsTextFormatSelfHealPending: true,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).toHaveBeenCalledWith({ reason: "search" });
  });

  it("skips search sync when nothing is dirty", async () => {
    const syncMock = vi.fn(async () => {});
    await startAsyncSearchSync({
      enabled: true,
      dirty: false,
      sessionsDirty: false,
      ftsTextFormatSelfHealPending: false,
      sync: syncMock,
      onError: vi.fn(),
    });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
